import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../../../integrations/storage/storage.service';
import { MultipartFile } from '@fastify/multipart';
import {
  getAttachmentFolderPath,
  PreparedFile,
  prepareFile,
  validateFileType,
} from '../attachment.utils';
import { v4 as uuid4, v7 as uuid7 } from 'uuid';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { AttachmentType, validImageExtensions } from '../attachment.constants';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { Attachment } from '@docmost/db/types/entity.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);
  constructor(
    private readonly storageService: StorageService,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceRepo: SpaceRepo,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async uploadFile(opts: {
    filePromise: Promise<MultipartFile>;
    pageId: string;
    userId: string;
    spaceId: string;
    workspaceId: string;
  }) {
    const { filePromise, pageId, spaceId, userId, workspaceId } = opts;
    const preparedFile: PreparedFile = await prepareFile(filePromise);

    const attachmentId = uuid7();
    const filePath = `${getAttachmentFolderPath(AttachmentType.File, workspaceId)}/${attachmentId}/${preparedFile.fileName}`;

    await this.uploadToDrive(filePath, preparedFile.buffer);

    let attachment: Attachment = null;
    try {
      attachment = await this.saveAttachment({
        attachmentId,
        preparedFile,
        filePath,
        type: AttachmentType.File,
        userId,
        spaceId,
        workspaceId,
        pageId,
      });
    } catch (err) {
      // delete uploaded file on error
      console.error(err);
    }

    return attachment;
  }

  async uploadImage(
    filePromise: Promise<MultipartFile>,
    type:
      | AttachmentType.Avatar
      | AttachmentType.WorkspaceLogo
      | AttachmentType.SpaceLogo,
    userId: string,
    workspaceId: string,
    spaceId?: string,
  ) {
    const preparedFile: PreparedFile = await prepareFile(filePromise);
    validateFileType(preparedFile.fileExtension, validImageExtensions);

    preparedFile.fileName = uuid4() + preparedFile.fileExtension;

    const filePath = `${getAttachmentFolderPath(type, workspaceId)}/${preparedFile.fileName}`;

    await this.uploadToDrive(filePath, preparedFile.buffer);

    let attachment: Attachment = null;
    let oldFileName: string = null;

    try {
      await executeTx(this.db, async (trx) => {
        attachment = await this.saveAttachment({
          preparedFile,
          filePath,
          type,
          userId,
          workspaceId,
          trx,
        });

        if (type === AttachmentType.Avatar) {
          const user = await this.userRepo.findById(userId, workspaceId, {
            trx,
          });

          oldFileName = user.avatarUrl;

          await this.userRepo.updateUser(
            { avatarUrl: preparedFile.fileName },
            userId,
            workspaceId,
            trx,
          );
        } else if (type === AttachmentType.WorkspaceLogo) {
          const workspace = await this.workspaceRepo.findById(workspaceId, {
            trx,
          });

          oldFileName = workspace.logo;

          await this.workspaceRepo.updateWorkspace(
            { logo: preparedFile.fileName },
            workspaceId,
            trx,
          );
        } else if (type === AttachmentType.SpaceLogo && spaceId) {
          const space = await this.spaceRepo.findById(spaceId, workspaceId, {
            trx,
          });

          oldFileName = space.logo;

          await this.spaceRepo.updateSpace(
            { logo: preparedFile.fileName },
            spaceId,
            workspaceId,
            trx,
          );
        } else {
          throw new BadRequestException(`Image upload aborted.`);
        }
      });
    } catch (err) {
      // delete uploaded file on db update failure
      this.logger.error('Image upload error:', err);
      await this.deleteRedundantFile(filePath);
      throw new BadRequestException('Failed to upload image');
    }

    if (oldFileName && !oldFileName.toLowerCase().startsWith('http')) {
      // delete old avatar or logo
      const oldFilePath =
        getAttachmentFolderPath(type, workspaceId) + '/' + oldFileName;
      await this.deleteRedundantFile(oldFilePath);
    }

    return attachment;
  }

  async deleteRedundantFile(filePath: string) {
    try {
      await this.storageService.delete(filePath);
      await this.attachmentRepo.deleteAttachmentByFilePath(filePath);
    } catch (error) {
      this.logger.error('deleteRedundantFile', error);
    }
  }

  async uploadToDrive(filePath: string, fileBuffer: any) {
    try {
      await this.storageService.upload(filePath, fileBuffer);
    } catch (err) {
      this.logger.error('Error uploading file to drive:', err);
      throw new BadRequestException('Error uploading file to drive');
    }
  }

  async saveAttachment(opts: {
    attachmentId?: string;
    preparedFile: PreparedFile;
    filePath: string;
    type: AttachmentType;
    userId: string;
    workspaceId: string;
    pageId?: string;
    spaceId?: string;
    trx?: KyselyTransaction;
  }): Promise<Attachment> {
    const {
      attachmentId,
      preparedFile,
      filePath,
      type,
      userId,
      workspaceId,
      pageId,
      spaceId,
      trx,
    } = opts;
    return this.attachmentRepo.insertAttachment(
      {
        id: attachmentId,
        type: type,
        filePath: filePath,
        fileName: preparedFile.fileName,
        fileSize: preparedFile.fileSize,
        mimeType: preparedFile.mimeType,
        fileExt: preparedFile.fileExtension,
        creatorId: userId,
        workspaceId: workspaceId,
        pageId: pageId,
        spaceId: spaceId,
      },
      trx,
    );
  }
}

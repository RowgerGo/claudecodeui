import { pipeline } from 'node:stream/promises';

import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  FileTreeLogger,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type FileTreeUploadLimits = {
  maximumFileSizeMegabytes: number;
  maximumFileCount: number;
};

type UploadedRequest = Request & {
  files?: Express.Multer.File[];
};

function readBody(request: Request): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null
    ? request.body as Record<string, unknown>
    : {};
}

function readRequiredString(value: unknown, fieldName: string, message?: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(message ?? `${fieldName} is required`, {
      code: 'INVALID_FILE_TREE_REQUEST',
      statusCode: 400,
    });
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readProjectId(request: Request): string {
  return readRequiredString(request.params.projectId, 'projectId');
}

function readQueryString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new AppError(`Invalid ${name}`, { code: 'INVALID_FILE_TREE_REQUEST', statusCode: 400 });
  }
  return value;
}

// The client cancels obsolete searches and directory loads. Stop filesystem
// work as soon as the response socket closes, including on project switches.
function responseSignal(response: Response): AbortSignal {
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  return controller.signal;
}

function readEntryType(value: unknown): 'file' | 'directory' {
  if (value !== 'file' && value !== 'directory') {
    throw new AppError('Type must be "file" or "directory"', {
      code: 'INVALID_FILE_TREE_ENTRY_TYPE',
      statusCode: 400,
    });
  }
  return value;
}

function readRelativePaths(value: unknown): string[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function readRequestedFileCount(value: unknown, fallbackCount: number): number {
  const parsedCount = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : fallbackCount;
}

function normalizeUploadedFiles(request: UploadedRequest): FileTreeUploadedFile[] {
  return Array.isArray(request.files)
    ? request.files.map((file) => ({
        originalName: file.originalname,
        temporaryPath: file.path,
        size: file.size,
        mimeType: file.mimetype,
      }))
    : [];
}

function createRouteHandler(
  operation: (request: Request, response: Response) => void | Promise<void>,
  logger: FileTreeLogger,
): RequestHandler {
  return async (request, response) => {
    try {
      await operation(request, response);
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof AppError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error('File Tree API error', error);
      response.status(500).json({ error: message });
    }
  };
}

/**
 * Builds the File Tree HTTP router for the server composition root and route tests.
 * Paths are relative to the module's `/api/file-tree` mount point so the
 * complete HTTP surface has one feature-owned namespace.
 */
export function createFileTreeRouter(
  services: FileTreeServices,
  uploadFilesMiddleware: RequestHandler,
  uploadLimits: FileTreeUploadLimits,
  logger: FileTreeLogger,
): express.Router {
  const router = express.Router();

  router.get('/browse-filesystem', createRouteHandler(async (request, response) => {
    response.json(await services.browseWorkspace(readOptionalString(request.query.path)));
  }, logger));

  router.post('/create-folder', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const folderPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.createWorkspaceFolder(folderPath));
  }, logger));

  router.get('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.filePath, 'filePath', 'Invalid file path');
    response.json(await services.readTextFile(readProjectId(request), filePath));
  }, logger));

  router.get('/projects/:projectId/archive', createRouteHandler(async (request, response) => {
    const folderPath = readRequiredString(readQueryString(request.query.path, 'path'), 'path');
    const signal = responseSignal(response);
    const archive = await services.openFolderArchive(readProjectId(request), folderPath, signal);
    response.attachment(archive.filename).type('application/zip').set('Cache-Control', 'no-store');
    // A stream failure destroys the response so partial ZIPs fail to download.
    await pipeline(archive.stream, response, { signal });
  }, logger));

  router.get('/projects/:projectId/files/content', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.path, 'path', 'Invalid file path');
    const file = await services.openFile(readProjectId(request), filePath);
    response.setHeader('Content-Type', file.contentType);
    file.stream.pipe(response);
    file.stream.on('error', (error) => {
      logger.error('Error streaming File Tree content', error);
      if (!response.headersSent) {
        response.status(500).json({ error: 'Error reading file' });
      }
    });
  }, logger));

  router.put('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const filePath = readRequiredString(body.filePath, 'filePath', 'Invalid file path');
    if (body.content === undefined) {
      throw new AppError('Content is required', {
        code: 'FILE_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }
    if (typeof body.content !== 'string') {
      throw new AppError('Content must be a string', {
        code: 'INVALID_FILE_CONTENT',
        statusCode: 400,
      });
    }
    response.json(await services.saveTextFile(readProjectId(request), filePath, body.content));
  }, logger));

  router.get('/projects/:projectId/directory', createRouteHandler(async (request, response) => {
    const page = await services.listProjectDirectory(readProjectId(request), {
      path: readQueryString(request.query.path, 'directory path') ?? '',
      cursor: readQueryString(request.query.cursor, 'directory cursor'),
      childName: readQueryString(request.query.childName, 'child name'),
      signal: responseSignal(response),
    });
    response.json(page);
  }, logger));

  router.get('/projects/:projectId/search', createRouteHandler(async (request, response) => {
    const limitValue = readQueryString(request.query.limit, 'search limit');
    const limit = limitValue === undefined ? 100 : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new AppError('Search limit must be between 1 and 500', {
        code: 'INVALID_SEARCH_LIMIT', statusCode: 400,
      });
    }
    const match = readQueryString(request.query.match, 'search mode');
    if (match !== undefined && match !== 'suffix') {
      throw new AppError('Invalid search mode', { code: 'INVALID_SEARCH_MODE', statusCode: 400 });
    }
    const results = await services.searchProjectFiles(readProjectId(request), {
      query: readQueryString(request.query.q, 'search query') ?? '',
      limit,
      filesOnly: request.query.filesOnly === 'true',
      match,
      signal: responseSignal(response),
    });
    response.json(results);
  }, logger));

  router.get('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    response.json(await services.listProjectFiles(readProjectId(request), {
      respectGitignore: request.query.respectGitignore === 'true',
    }));
  }, logger));

  router.post('/projects/:projectId/files/create', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.name || !body.type) {
      throw new AppError('Name and type are required', {
        code: 'FILE_TREE_ENTRY_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    const name = readRequiredString(body.name, 'name');
    const type = readEntryType(body.type);
    const parentPath = readOptionalString(body.path) ?? '';
    response.json(await services.createEntry({
      projectId: readProjectId(request),
      parentPath,
      type,
      name,
    }));
  }, logger));

  router.put('/projects/:projectId/files/rename', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.oldPath || !body.newName) {
      throw new AppError('oldPath and newName are required', {
        code: 'FILE_TREE_RENAME_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    response.json(await services.renameEntry({
      projectId: readProjectId(request),
      oldPath: readRequiredString(body.oldPath, 'oldPath'),
      newName: readRequiredString(body.newName, 'newName'),
    }));
  }, logger));

  router.delete('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const targetPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.deleteEntry({
      projectId: readProjectId(request),
      targetPath,
    }));
  }, logger));

  const uploadHandler = createRouteHandler(async (request, response) => {
    const uploadedRequest = request as UploadedRequest;
    const body = readBody(request);
    const files = normalizeUploadedFiles(uploadedRequest);
    response.json(await services.storeUploadedFiles({
      projectId: readProjectId(request),
      targetPath: readOptionalString(body.targetPath) ?? '',
      relativePaths: readRelativePaths(body.relativePaths),
      requestedFileCount: readRequestedFileCount(body.requestedFileCount, files.length),
      files,
    }));
  }, logger);

  router.post(
    '/projects/:projectId/files/upload',
    (request: Request, response: Response, next: NextFunction) => {
      uploadFilesMiddleware(request, response, (error?: unknown) => {
        if (!error) {
          void uploadHandler(request, response, next);
          return;
        }

        const errorCode = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : null;
        if (errorCode === 'LIMIT_FILE_SIZE') {
          response.status(400).json({
            error: `File too large. Maximum size is ${uploadLimits.maximumFileSizeMegabytes}MB.`,
          });
          return;
        }
        if (errorCode === 'LIMIT_FILE_COUNT') {
          response.status(400).json({
            error: `Too many files. Maximum is ${uploadLimits.maximumFileCount} files.`,
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      });
    },
  );

  return router;
}

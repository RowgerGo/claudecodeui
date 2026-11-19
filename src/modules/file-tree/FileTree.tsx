import { useCallback, useState, useEffect, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, X, Loader2, Folder, Upload } from 'lucide-react';

import { cn } from '@/shared/utils';
import { ICON_SIZE_CLASS, getFileIconData } from '@/modules/file-tree/utils/fileIcons';
import { useExpandedDirectories } from '@/modules/file-tree/hooks/useExpandedDirectories';
import { useFileTreeData } from '@/modules/file-tree/hooks/useFileTreeData';
import { useFileTreeOperations } from '@/modules/file-tree/hooks/useFileTreeOperations';
import { useProjectFileSearch } from '@/shared/hooks/useProjectFileSearch';
import { useFileTreeViewMode } from '@/modules/file-tree/hooks/useFileTreeViewMode';
import { useFileTreeUpload } from '@/modules/file-tree/hooks/useFileTreeUpload';
import type { DirectoryRevealRequest, FileTreeImageSelection, FileTreeNode, Project } from '@/shared/types';
import { formatFileSize, formatRelativeTime, isImageFile } from '@/modules/file-tree/utils/fileTreeUtils';
import { directoryRevealSegments } from '@/modules/file-tree/utils/revealDirectory';
import { ScrollArea, Input } from '@/shared/ui';
import FileTreeBody from '@/modules/file-tree/FileTreeBody';
import FileTreeDetailedColumns from '@/modules/file-tree/FileTreeDetailedColumns';
import FileTreeHeader from '@/modules/file-tree/FileTreeHeader';
import FileTreeUploadProgress from '@/modules/file-tree/FileTreeUploadProgress';
import ImageViewer from '@/modules/file-tree/ImageViewer';


type FileTreeProps = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  // Directory to reveal (from an in-chat `path/` reference): its ancestors are
  // expanded so the folder is visible without hunting through the tree.
  revealDirectory?: DirectoryRevealRequest | null;
};

/** Exported through the file-tree barrel; the project-workspace module renders it as the Files sidebar tab. */
export default function FileTree(props: FileTreeProps) {
  // Directory caches, in-flight reveals and expanded rows belong to one project.
  const project = props.selectedProject;
  return <ProjectFileTree key={JSON.stringify([project?.projectId, project?.path || project?.fullPath])} {...props} />;
}

function ProjectFileTree({ selectedProject, onFileOpen, revealDirectory }: FileTreeProps) {
  const { t } = useTranslation();
  const [selectedImage, setSelectedImage] = useState<FileTreeImageSelection | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Show toast notification
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const projectRoot = selectedProject?.path || selectedProject?.fullPath || '';
  const { getDirectory, load, refreshDirectory, refreshTree } = useFileTreeData(selectedProject?.projectId, projectRoot);
  const { viewMode, changeViewMode } = useFileTreeViewMode();
  const { expandedDirs, toggleDirectory, expandDirectories, collapseAll, forgetDirectory } = useExpandedDirectories();
  // The input stays visible while cancellable searches run across the project.
  const [searchQuery, setSearchQuery] = useState('');
  const showingResults = Boolean(searchQuery.trim());
  const search = useProjectFileSearch(selectedProject?.projectId, showingResults ? searchQuery.trim() : null);
  const root = getDirectory('');
  const items = showingResults ? search.entries : root.entries;
  const loading = showingResults ? search.loading : root.loading;
  const error = showingResults ? search.error : root.error;
  // Highlight the resolved row after switching from results or following a chat reference.
  const [revealedPath, setRevealedPath] = useState<string | null>(null);
  const revealSequence = useRef(0);
  const rowsRef = useRef<HTMLDivElement>(null);

  const reveal = useCallback(async (reference: string, targetType: FileTreeNode['type'], signal?: AbortSignal) => {
    const sequence = ++revealSequence.current;
    const segments = directoryRevealSegments(projectRoot, reference);
    let parent = '';
    let found: FileTreeNode | undefined;
    for (const [index, name] of segments.entries()) {
      const directory = await load(parent, { childName: name });
      if (signal?.aborted || sequence !== revealSequence.current || !directory) return;
      if (index === 0) setSearchQuery('');
      const requiredType = index === segments.length - 1 ? targetType : 'directory';
      const entry = directory.entries.find((item) => item.name === name && item.type === requiredType);
      if (!entry) break;
      found = entry;
      if (entry.type === 'directory') {
        expandDirectories([entry.path]);
        parent = entry.path;
        if (index === segments.length - 1) await load(parent);
      }
    }
    if (!signal?.aborted && sequence === revealSequence.current && found) setRevealedPath(found.path);
  }, [projectRoot, load, expandDirectories]);

  useEffect(() => {
    if (!revealDirectory) return;
    const request = new AbortController();
    // Start after the project's initial directory load. A replaced chat request never expands stale rows.
    queueMicrotask(() => {
      if (!request.signal.aborted) void reveal(revealDirectory.path, 'directory', request.signal);
    });
    return () => request.abort();
  }, [revealDirectory, reveal]);

  useEffect(() => {
    if (!revealedPath || showingResults) return;
    const row = Array.from(rowsRef.current?.querySelectorAll<HTMLElement>('[data-file-tree-path]') ?? [])
      .find((element) => element.dataset.fileTreePath === revealedPath);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [revealedPath, showingResults]);

  const refreshAfterMutation = (directory: string, removedPath?: string) => {
    if (removedPath) forgetDirectory(removedPath);
    refreshDirectory(directory, removedPath);
    if (showingResults) search.refresh();
  };
  const refreshView = () => {
    if (showingResults) {
      search.refresh();
    } else {
      refreshTree(expandedDirs);
    }
  };

  // File operations
  const operations = useFileTreeOperations({
    selectedProject,
    onRefresh: refreshAfterMutation,
    showToast,
  });

  // File upload (drag and drop). `treeRef` is pulled out of the returned object
  // so the remaining plain values are not treated as render-time ref reads.
  const { treeRef, ...upload } = useFileTreeUpload({
    selectedProject,
    onRefresh: refreshAfterMutation,
    showToast,
  });
  const operationLoading = operations.operationLoading || upload.operationLoading;

  // Folder-targeted uploads (context menu / hover button) share one hidden
  // input; the target path is remembered until the user picks the files.
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const folderUploadTargetRef = useRef('');
  const { uploadFiles } = upload;

  const handleUploadToFolder = useCallback((targetPath: string) => {
    folderUploadTargetRef.current = targetPath;
    folderUploadInputRef.current?.click();
  }, []);

  const handleFolderUploadInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { files: pickedFiles } = event.target;
      if (pickedFiles && pickedFiles.length > 0) {
        uploadFiles(Array.from(pickedFiles), folderUploadTargetRef.current);
      }
      event.target.value = '';
    },
    [uploadFiles],
  );

  // Focus input when creating new item
  useEffect(() => {
    if (operations.isCreating && newItemInputRef.current) {
      newItemInputRef.current.focus();
      newItemInputRef.current.select();
    }
  }, [operations.isCreating]);

  // Focus input when renaming
  useEffect(() => {
    if (operations.renamingItem && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [operations.renamingItem]);

  const renderFileIcon = useCallback((filename: string) => {
    const { icon: Icon, color } = getFileIconData(filename);
    return <Icon className={cn(ICON_SIZE_CLASS, color)} />;
  }, []);

  // Centralized click behavior keeps file actions identical across all presentation modes.
  const handleItemClick = useCallback(
    (item: FileTreeNode) => {
      if (showingResults) {
        setSearchQuery('');
        void reveal(item.path, item.type);
      } else if (item.type === 'directory') {
        revealSequence.current++;
        if (!expandedDirs.has(item.path)) void load(item.path);
        toggleDirectory(item.path);
      }
      if (item.type === 'directory') return;

      if (isImageFile(item.name) && selectedProject) {
        setSelectedImage({
          name: item.name,
          path: item.path,
          projectPath: selectedProject.path,
          // Image URL uses the DB projectId so ImageViewer can hit the
          // /api/file-tree/projects/:projectId/files/content endpoint directly.
          projectId: selectedProject.projectId,
        });
        return;
      }

      onFileOpen?.(item.path);
    },
    [expandedDirs, load, onFileOpen, reveal, selectedProject, showingResults, toggleDirectory],
  );

  const formatRelativeTimeLabel = useCallback(
    (date?: string) => formatRelativeTime(date, t),
    [t],
  );

  const renderDirectoryStatus = (path: string, level: number) => {
    const directory = getDirectory(path);
    const status = showingResults ? search : directory;
    const more = !showingResults && Boolean(directory.nextCursor);
    if (!status.loading && !status.error && !more) return null;
    const retry = () => {
      if (showingResults) search.refresh();
      else void load(path, { cursor: directory.failedCursor, refresh: true });
    };
    return (
      <div className="flex flex-wrap items-center gap-2 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: level * 16 + 6 }}>
        {status.loading ? <span role="status">{t('fileTree.loading')}</span> : status.error ? (
          <>
            <span role="alert">{status.error}</span>
            <button type="button" className="text-primary underline" onClick={retry}>{t('common.retry')}</button>
          </>
        ) : (
          <button type="button" className="text-primary hover:underline"
            onClick={() => void load(path, { cursor: directory.nextCursor ?? undefined })}>
            {t('fileTree.loadMore')}
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      ref={treeRef}
      className="relative flex h-full flex-col bg-background"
      onDragEnter={upload.handleDragEnter}
      onDragOver={upload.handleDragOver}
      onDragLeave={upload.handleDragLeave}
      onDrop={upload.handleDrop}
    >
      {/* Hidden input for folder-targeted uploads (context menu / hover button) */}
      <input
        ref={folderUploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderUploadInputChange}
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Drag overlay; pointer-events-none keeps folder rows reachable as drop targets */}
      {upload.isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-500/10">
          <div className="flex items-center gap-3 rounded-lg bg-background/95 px-6 py-4 shadow-lg">
            <Upload className="h-6 w-6 text-blue-500" />
            <span className="text-sm font-medium">
              {upload.dropTarget
                ? t('fileTree.dropToUploadTo', 'Drop files to upload to "{{folder}}"', {
                    folder: upload.dropTarget.split(/[\\/]/).pop(),
                  })
                : t('fileTree.dropToUpload', 'Drop files to upload')}
            </span>
          </div>
        </div>
      )}

      <FileTreeHeader
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        searchQuery={searchQuery}
        onSearchQueryChange={(value) => { revealSequence.current++; setSearchQuery(value); }}
        onUploadFiles={upload.handleFileSelect}
        onNewFile={() => operations.handleStartCreate('', 'file')}
        onNewFolder={() => operations.handleStartCreate('', 'directory')}
        onRefresh={refreshView}
        onCollapseAll={() => { revealSequence.current++; collapseAll(); }}
        loading={loading}
        operationLoading={operationLoading}
        isUploading={upload.uploadProgress?.status === 'uploading'}
        uploadProgress={upload.uploadProgress?.progress ?? null}
      />

      <FileTreeUploadProgress upload={upload.uploadProgress} />

      {viewMode === 'detailed' && items.length > 0 && <FileTreeDetailedColumns />}

      <ScrollArea className="flex-1 px-2 py-1">
        {/* New item input */}
        {operations.isCreating && (
          <div
            className="mb-1 flex items-center gap-1.5 py-[3px] pr-2"
            style={{ paddingLeft: `${(operations.newItemParent.split('/').length - 1) * 16 + 4}px` }}
          >
            {operations.newItemType === 'directory' ? (
              <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-500')} />
            ) : (
              <span className="ml-[18px]">{renderFileIcon(operations.newItemName)}</span>
            )}
            <Input
              ref={newItemInputRef}
              type="text"
              value={operations.newItemName}
              onChange={(e) => operations.setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') operations.handleConfirmCreate();
                if (e.key === 'Escape') operations.handleCancelCreate();
              }}
              onBlur={() => {
                setTimeout(() => {
                  if (operations.isCreating) operations.handleConfirmCreate();
                }, 100);
              }}
              className="h-6 flex-1 text-sm"
              disabled={operationLoading}
            />
          </div>
        )}

        <div ref={rowsRef}>
          <FileTreeBody
            items={items}
            loading={loading}
            error={error}
            truncated={showingResults && search.truncated}
            searchResults={showingResults}
            getEntries={(path) => getDirectory(path).entries}
            renderDirectoryStatus={renderDirectoryStatus}
            revealedPath={revealedPath}
            viewMode={viewMode}
            expandedDirs={expandedDirs}
            onItemClick={handleItemClick}
            renderFileIcon={renderFileIcon}
            formatFileSize={formatFileSize}
            formatRelativeTime={formatRelativeTimeLabel}
            onRename={operations.handleStartRename}
            onDelete={operations.handleStartDelete}
            onNewFile={(path) => operations.handleStartCreate(path, 'file')}
            onNewFolder={(path) => operations.handleStartCreate(path, 'directory')}
            onCopyPath={operations.handleCopyPath}
            onDownload={operations.handleDownload}
            onUpload={handleUploadToFolder}
            onRefresh={refreshView}
            dropTarget={upload.dropTarget}
            onItemDragOver={upload.handleItemDragOver}
            // Pass rename state and handlers for inline editing
            renamingItem={operations.renamingItem}
            renameValue={operations.renameValue}
            setRenameValue={operations.setRenameValue}
            handleConfirmRename={operations.handleConfirmRename}
            handleCancelRename={operations.handleCancelRename}
            renameInputRef={renameInputRef}
            operationLoading={operationLoading}
          />
        </div>
      </ScrollArea>

      {selectedImage && (
        <ImageViewer
          file={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {operations.deleteConfirmation.isOpen && operations.deleteConfirmation.item && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-red-100 p-2 dark:bg-red-900/30">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {t('fileTree.delete.title', 'Delete {{type}}', {
                    type: operations.deleteConfirmation.item.type === 'directory' ? 'Folder' : 'File'
                  })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {operations.deleteConfirmation.item.name}
                </p>
              </div>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {operations.deleteConfirmation.item.type === 'directory'
                ? t('fileTree.delete.folderWarning', 'This folder and all its contents will be permanently deleted.')
                : t('fileTree.delete.fileWarning', 'This file will be permanently deleted.')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={operations.handleCancelDelete}
                disabled={operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={operations.handleConfirmDelete}
                disabled={operationLoading}
                className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {operationLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-4 right-4 z-[9999] px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-bottom-2',
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          )}
        >
          {toast.type === 'success' ? (
            <Check className="h-4 w-4" />
          ) : (
            <X className="h-4 w-4" />
          )}
          <span className="text-sm">{toast.message}</span>
        </div>
      )}
    </div>
  );
}

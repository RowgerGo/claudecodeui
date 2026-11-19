import type { ComponentProps } from 'react';
import { Folder, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import FileTreeEmptyState from '@/modules/file-tree/FileTreeEmptyState';
import FileTreeList from '@/modules/file-tree/FileTreeList';

type FileTreeBodyProps = ComponentProps<typeof FileTreeList> & {
  loading: boolean;
  error: string | null;
  truncated: boolean;
};

/** Used by FileTree for cached root rows, flat search results, and their feedback. */
export default function FileTreeBody({ loading, error, truncated, ...list }: FileTreeBodyProps) {
  const { t } = useTranslation();
  return (
    <>
      {list.items.length > 0 ? (
        <FileTreeList {...list} />
      ) : !loading && !error && (
        <FileTreeEmptyState
          icon={list.searchResults ? Search : Folder}
          title={t(list.searchResults ? 'fileTree.noMatchesFound' : 'fileTree.noFilesFound')}
          description={t(list.searchResults ? 'fileTree.tryDifferentSearch' : 'fileTree.checkProjectPath')}
        />
      )}
      {list.renderDirectoryStatus('', 0)}
      {truncated && (
        <p className="px-2 py-1 text-xs text-muted-foreground">{t('fileTree.refineSearch')}</p>
      )}
    </>
  );
}

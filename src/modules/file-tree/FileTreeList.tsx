import type { ComponentProps } from 'react';

import type { FileTreeNode as FileTreeItem } from '@/shared/types';
import FileTreeNode from '@/modules/file-tree/FileTreeNode';

type FileTreeListProps = Omit<ComponentProps<typeof FileTreeNode>, 'item' | 'level'> & {
  items: FileTreeItem[];
};

/** Used by FileTreeBody for both the root listing and the flat project search results. */
export default function FileTreeList({ items, ...rowProps }: FileTreeListProps) {
  return (
    <div>
      {items.map((item) => (
        <FileTreeNode {...rowProps} key={item.path} item={item} level={0} />
      ))}
    </div>
  );
}

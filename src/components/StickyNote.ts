// Sample-repo stub. In the full app, StickyNote.tsx is the sticky-note
// component itself; only its model types are needed here, reproduced
// verbatim.

type StickyNoteBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  createdAt: string;
  // "Unpinned": pulled off the canvas but kept in the model so it can be
  // recovered from the stash tray / Omnibar. Optional so pre-feature stored
  // notes deserialise as visible; treated as false everywhere it's read.
  hidden?: boolean;
};

type ListItem = {
  id: string;
  text: string;
  completed: boolean;
  sortOrder: number | null;
  parentId: string | null;
  children: ListItem[];
};

type TextNote = StickyNoteBase & {
  noteType: 'text';
  text: string;
  title: null;
};

type ListNote = StickyNoteBase & {
  noteType: 'list';
  title: string;
  text: null;
  items: ListItem[];
};

type StickyNote = TextNote | ListNote;

export type { StickyNote, ListItem, TextNote, ListNote };

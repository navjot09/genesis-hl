/** Shape of the per-file diff attached to each assistant chat message. */
export type DiffRowKind = '+' | '-' | ' ' | 'gap'

export interface DiffRow {
  t: DiffRowKind
  text: string
}

export interface FileChange {
  path: string
  op: 'write' | 'edit' | 'delete'
  additions: number
  deletions: number
  rows: DiffRow[]
  truncated: boolean
}

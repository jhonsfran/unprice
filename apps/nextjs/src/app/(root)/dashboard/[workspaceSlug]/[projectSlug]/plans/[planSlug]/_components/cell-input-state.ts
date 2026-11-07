export type CellEdit = Readonly<{ initial: string; draft: string }> | null

type CellEditAction =
  | { type: "focus"; value: string }
  | { type: "change"; value: string }
  | { type: "blur" }

export function cellEditReducer(edit: CellEdit, action: CellEditAction): CellEdit {
  switch (action.type) {
    case "focus":
      return { initial: action.value, draft: action.value }
    case "change":
      return edit ? { ...edit, draft: action.value } : null
    case "blur":
      return null
  }
}

export function cellCommitOf(edit: CellEdit, value: string, retry: boolean): string | null {
  if (!edit || edit.initial !== value || (edit.draft === value && !retry)) return null
  return edit.draft
}

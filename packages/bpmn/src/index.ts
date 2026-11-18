/**
 * `@pilots/bpmn` — a process definition as a BPMN-style diagram.
 *
 * The definition is the only source of truth. `toDiagram` projects it, and every
 * edit is a command on the definition; the drawing is never parsed back.
 */
export {
  ANY_STATE,
  type DefinitionDocument,
  type LinkDocument,
  type RoleDocument,
  type SchemaDocument,
  type StateDocument,
  type TransitionDocument,
  type VisibilityDocument,
} from './document.js'
export {
  gatewayKey,
  laneKey,
  messageKey,
  stateKey,
  taskKey,
  timerKey,
  type DiagramEdge,
  type DiagramLane,
  type DiagramModel,
  type DiagramNode,
  type ElementRef,
  type Layer,
  type Marker,
  type NodeKind,
} from './model.js'
export { refOf, sourcesOf, targetsOf, toDiagram } from './project.js'
export {
  COLUMN_WIDTH,
  LANE_GUTTER,
  LANE_HEIGHT,
  autoLayout,
  laneAt,
  renameLayoutKeys,
  withLayout,
  type DiagramLayout,
} from './layout.js'
export { applyCommand } from './commands/apply.js'
export { IDENTIFIER, RESERVED_TRANSITION, bumpVersion, freshId, identifierFrom } from './commands/ids.js'
export { getPointer, parsePointer, pointerOf } from './commands/pointer.js'
export type {
  Command,
  CommandError,
  CommandErrorCode,
  CommandResult,
  ElementKind,
  ProcessPatch,
} from './commands/types.js'
export { dependentsOf } from './commands/references.js'
export {
  classify,
  readFields,
  removeField,
  schemaFor,
  setField,
  type FieldEdit,
  type FieldResult,
  type FieldType,
  type FieldView,
} from './forms/fields.js'
export {
  readTaskFields,
  writeTaskFields,
  type TaskFields,
  type TaskFieldsView,
} from './forms/task-fields.js'
export { readAccess, visibilityPaths, writeAccess, type Access } from './forms/visibility.js'
export { targetOf, type DiagnosticTarget } from './diagnostics.js'
export { isDrawable } from './drawable.js'

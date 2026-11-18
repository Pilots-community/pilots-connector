/** Field × role. A cell is: the default, always, or only in some states. */
import { readAccess, visibilityPaths, writeAccess, type Access, type Command, type DefinitionDocument } from '@pilots/bpmn'

import { ListField } from '../fields.js'

export function VisibilityMatrix({ document, run }: { document: DefinitionDocument; run: (c: Command) => void }) {
  const paths = visibilityPaths(document.data, document.visibility)
  const write = (path: string, role: string, access: Access): void =>
    run({ type: 'setProcess', patch: { visibility: writeAccess(document.visibility, path, role, access) } })
  return (
    <div className="flex flex-col gap-2" data-testid="visibility-matrix">
      <p className="text-xs text-slate-500">
        A field nobody is granted is {document.defaultVisibility === 'none' ? 'visible to nobody' : 'visible to everyone'}.
        The host still holds every value; this decides who may read it.
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500">
            <th>Field</th>
            {document.roles.map((role) => (
              <th key={role.id}>{role.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paths.map((path) => (
            <tr key={path}>
              <td className="font-mono">{path}</td>
              {document.roles.map((role) => {
                const access = readAccess(document.visibility, path, role.id)
                return (
                  <td key={role.id} className="py-1">
                    <select
                      className="rounded border border-slate-300 bg-transparent px-1 dark:border-slate-600"
                      value={access.kind}
                      onChange={(e) => {
                        const kind = e.target.value as Access['kind']
                        write(path, role.id, kind === 'states' ? { kind, states: [document.initialState] } : { kind })
                      }}
                    >
                      <option value="default">default</option>
                      <option value="always">always</option>
                      <option value="states">in states…</option>
                    </select>
                    {access.kind === 'states' && (
                      <ListField
                        className="mt-1 w-full rounded border border-slate-300 bg-transparent px-1 dark:border-slate-600"
                        value={access.states}
                        placeholder="STATE, STATE"
                        onCommit={(states) => write(path, role.id, { kind: 'states', states })}
                      />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

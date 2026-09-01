function createBackend() {
  const units = new Map()
  return {
    kv: {
      async open(descriptor) {
        let state = units.get(descriptor.name)
        if (state === undefined) {
          state = {
            tables: new Map(descriptor.tables.map(table => [table, new Map()])),
            global: null,
          }
          units.set(descriptor.name, state)
        }
        return {
          async loadAll() {
            return {
              tables: Object.fromEntries(
                [...state.tables].map(([name, records]) => [name, Object.fromEntries(records)]),
              ),
              global: state.global,
            }
          },
          async putRecord(table, key, value) { state.tables.get(table).set(key, value) },
          async deleteRecord(table, key) { state.tables.get(table).delete(key) },
          async setGlobal(value) { state.global = value },
          async close() {},
        }
      },
    },
    async close() {},
  }
}

export const name = 'workspace-memory-backend-fixture'
export const inject = ['storage']

export const apply = (ctx) => {
  const backend = createBackend()
  const disposeBackend = ctx.storage.backend.register('memory', backend)
  const disposeService = ctx.provide('storage.backend.memory', backend)
  return async () => {
    disposeService()
    disposeBackend()
    await backend.close()
  }
}

apply.inject = inject

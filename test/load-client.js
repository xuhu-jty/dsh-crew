// Load the hand-written lazy-CJS client half once and expose its factory output.
const loaded = []
globalThis.window = { __ModuleLoader__: { load: registration => loaded.push(registration) } }
await import('../client.js')
delete globalThis.window

/** React stub: components are not rendered offline, only their wiring is checked. */
export const reactStub = {
  createElement: (...args) => ({ args }),
  useEffect: () => {},
  useMemo: factory => factory(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

export const registration = loaded[0]
export const loadedCount = loaded.length
export const createPlugin = () => registration.factory(specifier => {
  if (specifier !== 'react') throw new Error(`unexpected require ${specifier}`)
  return reactStub
})

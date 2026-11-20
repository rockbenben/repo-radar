// Git's rev-parse --local-env-vars lists the overrides a hook must unset
// before running Git in another repository. Keep global config and credentials.
const repoEnv = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CONFIG",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_WORK_TREE",
])

export function gitEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    const key = name.toUpperCase()
    if (repoEnv.has(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[name]
  }
  return Object.assign(env, extra)
}

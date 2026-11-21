import path from 'node:path'

const locks = new Map()

// 同一文件的读-校验-写必须串行：原子替换只保证单次写入完整，挡不住两个请求各自覆盖整份文件。
export function withFileLock(file, task) {
  const key = path.resolve(file)
  const previous = locks.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  locks.set(key, next)
  return next.finally(() => {
    if (locks.get(key) === next) locks.delete(key)
  })
}

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRestartHandler } from '../index.js'

for (const mode of ['restart', 'quit']) {
  let ps1 = ''
  const handler = createRestartHandler({
    mode,
    execPath: 'C:\\Program Files\\DSH\\DSH.exe',
    pid: 4321,
    ppid: 1234,
    workDir: 'C:\\Program Files\\DSH',
    scriptPath: join(tmpdir(), `check-${mode}.ps1`),
    logPath: join(tmpdir(), 'check.log'),
    writeScript: async (path, text) => {
      if (path.endsWith('.ps1')) ps1 = text
    },
    spawnProcess: () => ({ unref() {} }),
  })
  const response = {
    status: 0,
    headers: {},
    setHeader() {},
    writeHead() {},
    end() {},
  }
  await handler({ method: 'POST', body: {} }, response)
  const file = join(process.env.TEMP ?? tmpdir(), `dsh-refresh-check-${mode}.ps1`)
  await writeFile(file, ps1, 'utf8')
  console.log(mode, '->', file, ps1.length)
}


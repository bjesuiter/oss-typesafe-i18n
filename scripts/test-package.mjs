import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const temp = await mkdtemp(join(tmpdir(), 'typesafe-i18n-package-'))
const fixture = join(temp, 'consumer')
let watcher
let log = ''

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		timeout: 120_000,
		shell: process.platform === 'win32' && command !== process.execPath,
	})
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(' ')}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`,
	)
	return result.stdout
}

async function waitFor(check) {
	const deadline = Date.now() + 20_000
	while (Date.now() < deadline) {
		assert.equal(watcher.exitCode, null, log)
		if (await check()) return
		await setTimeout(100)
	}
	assert.fail(`Generator timed out\n${log}`)
}

try {
	run('pnpm', ['pack', '--pack-destination', temp], root)
	const archive = (await readdir(temp)).find((name) => name.endsWith('.tgz'))
	assert.ok(archive, 'pnpm pack must produce an archive')
	await mkdir(join(fixture, 'src/i18n/en'), { recursive: true })
	await writeFile(
		join(fixture, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: { 'typesafe-i18n': `file:${join(temp, archive)}`, typescript: '7.0.2', 'solid-js': '1.7.9' },
		}),
	)
	await writeFile(join(fixture, '.typesafe-i18n.json'), JSON.stringify({ adapter: 'solid', baseLocale: 'en' }))
	const locale = join(fixture, 'src/i18n/en/index.ts')
	const types = join(fixture, 'src/i18n/i18n-types.ts')
	await writeFile(types, 'export type BaseTranslation = Record<string, string>\n')
	const localeSource = (messages) =>
		`import type { BaseTranslation } from '../i18n-types'\nconst en = ${messages} satisfies BaseTranslation\nexport default en\n`
	await writeFile(locale, localeSource("{ HELLO: 'Hello {name:string}!' }"))
	run('npm', ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'], fixture)
	assert.equal(
		JSON.parse(await readFile(join(fixture, 'node_modules/typescript/package.json'), 'utf8')).version,
		'7.0.2',
	)
	const cli = join(fixture, 'node_modules/typesafe-i18n/cli/typesafe-i18n.mjs')
	const output = run(process.execPath, [cli, '--no-watch'], fixture)
	assert.match(output, /generating files completed/)
	assert.match(await readFile(types, 'utf8'), /name: string/)
	await writeFile(
		join(fixture, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				skipLibCheck: true,
				target: 'ES2022',
				module: 'ESNext',
				moduleResolution: 'Bundler',
			},
			include: ['src'],
		}),
	)
	await writeFile(
		join(fixture, 'src/check.ts'),
		"import type { TranslationFunctions } from './i18n/i18n-types'\ndeclare const LL: TranslationFunctions\nLL.HELLO({ name: 'Ada' })\n// @ts-expect-error The generated argument must remain a string.\nLL.HELLO({ name: 42 })\n",
	)
	run(process.execPath, [join(fixture, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], fixture)
	watcher = spawn(process.execPath, [cli], { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] })
	watcher.stdout.on('data', (data) => {
		log += data
	})
	watcher.stderr.on('data', (data) => {
		log += data
	})
	watcher.on('error', (error) => {
		log += error.message
	})
	await waitFor(() => log.includes('all files are up to date'))
	// The generator ignores changes for one second after writing its own output.
	await setTimeout(1500)
	await writeFile(locale, localeSource("{ HELLO: 'Hello {name:string}!', COUNT: '{count:number} items' }"))
	await waitFor(async () => /count: number/.test(await readFile(types, 'utf8')))
	run(process.execPath, [join(fixture, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], fixture)
	console.log('Packed CLI generates typed messages and watches changes alongside TypeScript 7.0.2.')
} finally {
	if (watcher && watcher.exitCode === null) {
		const stopped = new Promise((resolve) => watcher.once('close', resolve))
		watcher.kill()
		await stopped
	}
	await rm(temp, { recursive: true, force: true })
}

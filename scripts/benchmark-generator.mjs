import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'

const args = process.argv.slice(2)
const argument = (name) => args[args.indexOf(name) + 1]
if (args.includes('--help') || !args.includes('--baseline') || !args.includes('--locales')) {
	console.log(
		'Usage: pnpm benchmark:generator --baseline <legacy-cli.mjs> --locales <i18n-directory> [--output <results.json>]',
	)
	process.exit(args.includes('--help') ? 0 : 1)
}
const temp = await mkdtemp(join(tmpdir(), 'typesafe-i18n-benchmark-'))
const baseline = resolve(argument('--baseline'))
const candidate = resolve(import.meta.dirname, '../cli/typesafe-i18n.mjs')
const localeSource = resolve(argument('--locales'))
const results = { startup: { legacy: [], native: [] }, updates: { legacy: [], native: [] } }
const generated = {}

async function measure(name, cli, round) {
	const fixture = join(temp, `${name}-${round}`)
	await cp(localeSource, join(fixture, 'src/i18n'), { recursive: true })
	await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
	await writeFile(join(fixture, '.typesafe-i18n.json'), JSON.stringify({ adapter: 'solid', baseLocale: 'en' }))
	const locale = join(fixture, 'src/i18n/en/index.ts')
	const original = await readFile(locale, 'utf8')
	assert.match(original, /const en = \{/)
	const started = performance.now()
	const child = spawn(process.execPath, [cli], { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] })
	let log = ''
	let pending
	let failed
	let timer
	const receive = (data) => {
		const chunk = data.toString()
		log += chunk
		if (chunk.includes('all files are up to date') && pending) {
			clearTimeout(timer)
			pending.resolve(performance.now())
			pending = undefined
		}
	}
	child.stdout.on('data', receive)
	child.stderr.on('data', receive)
	child.on('error', (error) => {
		failed = error
		pending?.reject(error)
	})
	child.on('exit', (code, signal) => {
		failed = new Error(`Generator exited (${code}, ${signal})\n${log}`)
		pending?.reject(failed)
	})
	const completion = () =>
		new Promise((resolve, reject) => {
			if (failed) return reject(failed)
			pending = { resolve, reject }
			timer = globalThis.setTimeout(() => reject(new Error(`Generator timed out\n${log}`)), 20_000)
		})
	try {
		results.startup[name].push((await completion()) - started)
		if (!generated[name]) {
			const folder = join(fixture, 'src/i18n')
			generated[name] = Object.fromEntries(
				await Promise.all(
					(await readdir(folder))
						.filter((file) => file.endsWith('.ts'))
						.sort()
						.map(async (file) => [file, await readFile(join(folder, file), 'utf8')]),
				),
			)
		}
		if (round === 0) {
			for (let index = 0; index < 5; index++) {
				// The generator suppresses file events for one second after each generation.
				await setTimeout(1500)
				const done = completion()
				const change = performance.now()
				await writeFile(
					locale,
					original.replace('const en = {', `const en = {\n BENCHMARK: 'Probe {value${index}:string}',`),
				)
				results.updates[name].push((await done) - change)
				assert.match(
					await readFile(join(fixture, 'src/i18n/i18n-types.ts'), 'utf8'),
					new RegExp(`value${index}: string`),
				)
			}
		}
	} finally {
		clearTimeout(timer)
		if (child.exitCode === null && child.signalCode === null) {
			const stopped = new Promise((resolve) => child.once('close', resolve))
			child.kill()
			await stopped
		}
	}
}

try {
	for (let round = 0; round < 5; round++) {
		const order =
			round % 2
				? [
						['native', candidate],
						['legacy', baseline],
				  ]
				: [
						['legacy', baseline],
						['native', candidate],
				  ]
		for (const [name, cli] of order) await measure(name, cli, round)
	}
	assert.deepEqual(generated.native, generated.legacy, 'Generated files must remain byte-identical')
	const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
	const report = {
		...results,
		medianMs: {
			startup: { legacy: median(results.startup.legacy), native: median(results.startup.native) },
			updates: { legacy: median(results.updates.legacy), native: median(results.updates.native) },
		},
		generatedFilesIdentical: true,
		node: process.version,
	}
	console.log(JSON.stringify(report, null, 2))
	if (args.includes('--output')) await writeFile(resolve(argument('--output')), JSON.stringify(report, null, 2) + '\n')
} finally {
	await rm(temp, { recursive: true, force: true })
}

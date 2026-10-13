import { execFile } from 'child_process'
import { createRequire as requireFrom } from 'module'
import { dirname, resolve } from 'path'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import { writeFile } from './utils/file.utils.mjs'

const moduleRequire = requireFrom(import.meta.url)
const packagePath = moduleRequire.resolve('typescript-native/package.json')
const compilerPath = resolve(dirname(packagePath), 'bin/tsc')
const compilerPackage = moduleRequire(packagePath) as { version: string }
const [major, minor] = compilerPackage.version.split('.')
export const compilerVersionMajorMinor = `${Number(major)}.${Number(minor)}` as const
const runCompiler = promisify(execFile)
let compilerCommand: Promise<{ file: string; args: string[] }> | undefined

export const compileLocale = async (languageFilePath: string, tempPath: string): Promise<void> => {
	// Keep the temporary JavaScript executable inside ESM projects too.
	await writeFile(resolve(tempPath, 'package.json'), JSON.stringify({ type: 'commonjs' }))
	const command = await getCompilerCommand()
	await runCompiler(command.file, [
		...command.args,
		'--ignoreConfig',
		'--noCheck',
		'--singleThreaded',
		'--types',
		'--target',
		'ES2015',
		'--lib',
		'ES5',
		'--module',
		'commonjs',
		'--moduleResolution',
		'bundler',
		'--allowJs',
		'--resolveJsonModule',
		'--skipLibCheck',
		'--outDir',
		resolve(tempPath),
		languageFilePath,
	])
}

const getCompilerCommand = () => {
	if (!compilerCommand) {
		compilerCommand = (async () => {
			try {
				// Use the same platform resolver as the pinned TypeScript CLI launcher.
				const resolver = await import(pathToFileURL(resolve(dirname(packagePath), 'lib/getExePath.js')).href)
				return { file: resolver.default() as string, args: [] }
			} catch (_error) {
				return { file: process.execPath, args: [compilerPath] }
			}
		})()
	}
	return compilerCommand
}

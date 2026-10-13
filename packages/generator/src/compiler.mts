import { execFile } from 'child_process'
import { createRequire as requireFrom } from 'module'
import { dirname, resolve } from 'path'
import { promisify } from 'util'
import { writeFile } from './utils/file.utils.mjs'

const moduleRequire = requireFrom(import.meta.url)
const packagePath = moduleRequire.resolve('typescript-native/package.json')
const compilerPath = resolve(dirname(packagePath), 'bin/tsc')
const compilerPackage = moduleRequire(packagePath) as { version: string }
const [major, minor] = compilerPackage.version.split('.')
export const compilerVersionMajorMinor = `${Number(major)}.${Number(minor)}` as const
const runCompiler = promisify(execFile)

export const compileLocale = async (languageFilePath: string, tempPath: string): Promise<void> => {
	// Keep the temporary JavaScript executable inside ESM projects too.
	await writeFile(resolve(tempPath, 'package.json'), JSON.stringify({ type: 'commonjs' }))
	await runCompiler(process.execPath, [
		compilerPath,
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

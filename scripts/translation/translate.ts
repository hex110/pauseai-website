import { createClient } from '@supabase/supabase-js'
import { hash } from 'crypto'
import 'dotenv/config'
import fs from 'fs/promises'
import OpenAI from 'openai'
import { join, relative, dirname } from 'path'
import PQueue from 'p-queue'
import inlangSettings from '../../project.inlang/settings.json'
import { generateJsonPrompt, generateMarkdownPrompt, PromptGenerator } from './prompts'
import { existsSync } from 'fs'

const PATH_JSON_BASE = './messages'
const PATH_JSON_SOURCE = './messages/en.json'
const BASE_URL = 'https://api.sambanova.ai/v1'
const API_KEY = process.env.SAMBANOVA_API_KEY
const MODEL = 'Meta-Llama-3.1-405B-Instruct'
const JSON_PATH_IN_CACHE = '_messages.json'
const SUPABASE_URL = 'http://127.0.0.1:54321'
const PATH_MD_BASE = 'src/posts'
const PATH_MD_TARGET = 'temp/translations'

const queue = new PQueue({
	concurrency: 1,
	intervalCap: 1,
	interval: 10000
})
const openai = new OpenAI({
	baseURL: BASE_URL,
	apiKey: API_KEY
})
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_API_KEY as string)
const languageNamesInEnglish = new Intl.DisplayNames('en', { type: 'language' })

{
	const languages = inlangSettings.languageTags
	const indexOfSourceLanguage = languages.indexOf(inlangSettings.sourceLanguageTag)
	languages.splice(indexOfSourceLanguage, 1)

	const markdownPathsFromBase = await fs.readdir(PATH_MD_BASE, { recursive: true })
	const markdownPathsFromRoot = markdownPathsFromBase.map((file) => join(PATH_MD_BASE, file))

	await Promise.all([
		translateOrLoadMessages(PATH_JSON_SOURCE, PATH_JSON_BASE, JSON_PATH_IN_CACHE, languages),
		translateOrLoadMarkdown(markdownPathsFromRoot, PATH_MD_BASE, languages, PATH_MD_TARGET)
	])
}

async function translateOrLoadMessages(
	path: string,
	basePath: string,
	pathInCache: string,
	languages: string[]
) {
	return await translateOrLoad(
		[path],
		() => pathInCache,
		languages,
		generateJsonPrompt,
		(language) => join(basePath, language + '.json')
	)
}

async function translateOrLoadMarkdown(
	paths: string[],
	basePath: string,
	languages: string[],
	target: string
) {
	return await translateOrLoad(
		paths,
		(path) => relative(basePath, path),
		languages,
		generateMarkdownPrompt,
		(language, path) => {
			const relativePath = relative(basePath, path)
			return join(target, language, relativePath)
		}
	)
}

type CacheNamingStrategy = (path: string) => string
type TargetStrategy = (language: string, path: string) => string

async function translateOrLoad(
	paths: string[],
	cacheNamingStrategy: CacheNamingStrategy,
	languages: string[],
	promptGenerator: PromptGenerator,
	targetStrategy: TargetStrategy
) {
	// for (path of paths) {
	await Promise.all(
		paths.map(async (path) => {
			const content = await fs.readFile(path, 'utf-8')
			const hashedContent = hash('md5', content)
			// for (language of languages) {
			await Promise.all(
				languages.map(async (language) => {
					const pathInCache = cacheNamingStrategy(path)
					const cached = await supabase.from('translation').select('translation').match({
						path: pathInCache,
						hash: hashedContent,
						language_code: language
					})
					let translated
					if (cached.data?.length) {
						console.log(`Using up-to-date translation from cache for ${pathInCache} in ${language}`)
						translated = cached.data[0].translation
					} else {
						translated = await translate(content, promptGenerator, language)
						const idResponse = await supabase.from('translation').select('id').match({
							path: pathInCache,
							language_code: language
						})
						const id = idResponse.data?.[0]?.id
						if (id)
							console.log(
								`Updating outdated translation in cache for ${pathInCache} in ${language}`
							)
						else console.log(`Creating new cache entry for ${pathInCache} in ${language}`)
						await supabase.from('translation').upsert({
							id: id,
							path: pathInCache,
							hash: hashedContent,
							language_code: language,
							translation: translated
						})
					}
					const target = targetStrategy(language, path)
					const directory = dirname(target)
					if (!existsSync(directory)) await fs.mkdir(directory, { recursive: true })
					await fs.writeFile(targetStrategy(language, path), translated)
				})
			)
		})
	)
}

async function translate(content: string, promptGenerator: PromptGenerator, language: string) {
	const languageName = languageNamesInEnglish.of(language)
	if (!languageName) throw new Error(`Couldn't resolve language code: ${language}`)
	const prompt = promptGenerator(languageName, content)
	const response = await queue.add(() =>
		openai.chat.completions.create({
			model: MODEL,
			messages: [
				{
					role: 'user',
					content: prompt
				}
			],
			temperature: 0
		})
	)
	const translated = response?.choices[0].message.content
	if (!translated) throw new Error(`Translation to ${languageName} failed`)
	return translated
}
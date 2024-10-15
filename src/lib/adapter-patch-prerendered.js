import fs from 'fs'
/**
 * @param {import("@sveltejs/kit").Adapter} adapter
 * @returns {import("@sveltejs/kit").Adapter}
 */
export default function (adapter) {
	return {
		...adapter,
		name: 'adapter-patch-prerendered',
		adapt(builder) {
			/**
			 * @type {import('../../project.inlang/settings.json')}
			 */
			const settings = JSON.parse(fs.readFileSync('./project.inlang/settings.json', 'utf-8'))
			builder.prerendered.paths = builder.prerendered.paths.filter((path) => {
				for (const tag of settings.languageTags) {
					if (path.startsWith('/' + tag)) return true
				}
			})
			adapter.adapt(builder)
		}
	}
}

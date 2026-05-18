import antfu from '@antfu/eslint-config'

export default antfu({
  vue: true,
  typescript: true,
  stylistic: {
    indent: 2,
    quotes: 'single',
    semi: false,
  },
  gitignore: true,
})

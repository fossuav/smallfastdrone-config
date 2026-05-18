import antfu from '@antfu/eslint-config'

export default antfu(
  {
    vue: true,
    typescript: true,
    stylistic: {
      indent: 2,
      quotes: 'single',
      semi: false,
    },
    gitignore: true,
  },
  // Bun CLI scripts under test/ (SITL bridge, future fixtures) and scripts/
  // are run by Bun, not the browser. Allow `console.log` for operator
  // output and `process` as a global (Bun provides it natively).
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      'node/prefer-global/process': 'off',
    },
  },
)

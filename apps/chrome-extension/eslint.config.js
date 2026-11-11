import { createBaseConfig } from '@veyquo/eslint-config/base';

export default [
  { name: 'chrome-extension/ignores', ignores: ['dist/**', 'test-results/**'] },
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
];

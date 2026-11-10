import { createBaseConfig } from '@veyquo/eslint-config/base';

export default [
  { name: 'desktop/ignores', ignores: ['build/**', 'build-host/**', 'release/**'] },
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
];

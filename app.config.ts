import type { ConfigContext, ExpoConfig } from 'expo/config';

const APP_SCHEME = 'tomoyard';
const APP_ID = 'com.anonymous.friendsthing';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'Tomo Together',
  slug: config.slug ?? 'friends-thing',
  scheme: APP_SCHEME,
  ios: {
    ...config.ios,
    bundleIdentifier: APP_ID,
  },
  android: {
    ...config.android,
    package: APP_ID,
  },
});

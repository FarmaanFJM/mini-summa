import { router, setParams } from './mocks/expo-router';
import { disposeAll } from './helpers/render';

jest.mock('expo-router', () => require('./mocks/expo-router'));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('expo-linking', () => ({ useURL: jest.fn(() => null), openURL: jest.fn() }));

jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    CameraView: (props: Record<string, unknown>) => React.createElement(View, { testID: 'camera-view', ...props }),
    useCameraPermissions: jest.fn(() => [{ granted: true, canAskAgain: true }, jest.fn(async () => ({ granted: true }))]),
  };
});

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 5, HIGH: 6 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getDevicePushTokenAsync: jest.fn(async () => ({ type: 'android', data: 'fcm-token-0123456789' })),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '0.1.0' } } }));

afterEach(() => {
  // A test that fails halfway must not leave fake timers behind for the next one.
  jest.useRealTimers();
  disposeAll();
});

beforeEach(() => {
  setParams({});
  router.canGoBack.mockReturnValue(true);
});

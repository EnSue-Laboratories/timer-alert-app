# Timer Alert App

Local-first countdown app built with React Native, Expo, and TypeScript.

## Features

- Multiple local countdown timers
- Start, pause, resume, reset, and delete controls
- Absolute target-time countdown calculation
- Scheduled local notifications with sound through `expo-notifications`
- Foreground popup alerts and vibration
- AsyncStorage persistence across app restarts
- Light and dark productivity-style UI
- No login, backend, or cloud sync

## Development

```bash
npm install
npm run web
```

Native testing uses Expo:

```bash
npm run android
npm run ios
```

Android background notification reliability should be tested on a physical device or emulator with notification permissions enabled.

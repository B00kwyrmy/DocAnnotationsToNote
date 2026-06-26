import { AppRegistry, Image, DeviceEventEmitter } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';
import { PluginManager } from 'sn-plugin-lib';

AppRegistry.registerComponent(appName, () => App);
PluginManager.init();

const BUTTON_ID = 1;

// Toolbar button (NOTE + DOC). showType:1 opens the full-screen App.
// Stage 1: run on the open PDF → extract all annotations → ordered report to EXPORT.
PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: BUTTON_ID,
  name: 'Doc → Note',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

PluginManager.registerButtonListener({
  onButtonPress: (msg) => {
    if (!msg || msg.id !== BUTTON_ID) return;
    DeviceEventEmitter.emit('docAnnotRun');
  },
});

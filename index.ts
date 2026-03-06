import { registerRootComponent } from 'expo';
import TrackPlayer from 'react-native-track-player';
import ReactNativeForegroundService from '@supersami/rn-foreground-service';
import App from './App';

// 注册前台服务
ReactNativeForegroundService.register({ config: { alert: false, onServiceErrorCallBack: () => {} } });

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

// 必须注册此服务，否则 v5 版本无法在安卓上初始化播放器
TrackPlayer.registerPlaybackService(() => async () => {
  // 这里可以添加后台事件监听（如下一首、远程控制等）
});
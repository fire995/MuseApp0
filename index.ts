import { registerRootComponent } from 'expo';
import ReactNativeForegroundService from '@supersami/rn-foreground-service';
import App from './App';

// 注册前台服务
ReactNativeForegroundService.register({ config: { alert: false, onServiceErrorCallBack: () => { } } });

// registerRootComponent calls AppRegistry.registerComponent('main', () => App)
registerRootComponent(App);
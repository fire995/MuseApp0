declare module 'react-native-share-menu' {
  export interface ShareData {
    mimeType: string;
    data: string | string[];
    extraData?: any;
  }

  export type ShareCallback = (share: ShareData | null) => void;

  export interface ShareMenuType {
    getInitialShare: (callback: ShareCallback) => void;
    addNewShareListener: (callback: ShareCallback) => { remove: () => void };
  }

  const ShareMenu: ShareMenuType;
  export default ShareMenu;
}

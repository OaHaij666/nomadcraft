export interface YsmAsset { id:string; name:string; modelId:string; textures:string[]; animationCount:number; createdAt:number }
export interface YsmViewerPayload { engine:"ysmviewer-1"; spec:string; textures:Array<{id:string;name:string;png:string}>; animations:string[] }
export interface YsmPreview { viewer?:YsmViewerPayload; asset:YsmAsset; geometry:string; textures:Array<{name:string;png:string}>; animations:string[]; controllers:string[]; defaultAnimation?:string }
export interface DefaultYsm { enabled:boolean; assetId?:string; texture?:string; animation?:string; previewOnHome:boolean }

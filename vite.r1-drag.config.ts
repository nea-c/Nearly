import config from './vite.config';
export default {...(typeof config==='function'?config({command:'serve',mode:'test',isSsrBuild:false,isPreview:false}):config),optimizeDeps:{noDiscovery:true,entries:[]}};

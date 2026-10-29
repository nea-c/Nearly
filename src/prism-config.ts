// Loaded before Prism in our private worker. No DOM scanning or extra workers.
(globalThis as typeof globalThis&{Prism?:unknown}).Prism={manual:true,disableWorkerMessageHandler:true};

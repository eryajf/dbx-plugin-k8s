import { createContext, useContext, type ReactNode } from 'react'
const RuntimeContext = createContext({isDesktop: false, isReady: true})
export function RuntimeProvider({children}: {children: ReactNode}) {return <RuntimeContext.Provider value={{isDesktop: false, isReady: true}}>{children}</RuntimeContext.Provider>}
export function useRuntime() {return useContext(RuntimeContext)}

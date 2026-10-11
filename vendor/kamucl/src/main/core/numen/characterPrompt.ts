import { UPSTREAM_DEFAULT_PERSONA } from './prompt'
/** Follows Numen SystemPromptComposer: bound persona -> global persona -> built-in persona. */
export function personaSection(text:string|undefined,globalPersona:string):string {
  const body=text?.trim()?text:globalPersona.trim()?globalPersona:UPSTREAM_DEFAULT_PERSONA
  return '<persona>\n'+body+'\n</persona>'
}

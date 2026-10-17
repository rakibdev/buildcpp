export const quoteShell = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

export const ninjaValue = (args: string[]) => args.map(quoteShell).join(' ').replaceAll('$', '$$$$')

export const ninjaPath = (file: string) => file.replace(/[$ :]/g, '$$$&')

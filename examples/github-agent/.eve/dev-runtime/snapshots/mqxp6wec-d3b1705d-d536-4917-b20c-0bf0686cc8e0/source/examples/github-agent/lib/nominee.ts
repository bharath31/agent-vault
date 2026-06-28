import { Nominee } from 'nominee'
import { auth0 } from 'nominee-auth0'

export const nominee = new Nominee({ strategy: auth0() })

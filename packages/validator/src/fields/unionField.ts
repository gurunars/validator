import { Field, SpecUnion, TypeHint } from '../core'
import { Json } from '../Json'
import { merge } from '../utils'
import booleanField from './booleanField'
import choiceField from './choiceField'
import objectField from './objectField'
import stringField from './stringField'


type Unioned<T extends SpecUnion<any>[]> = {
  [P in keyof T]: T[P] extends SpecUnion<any> ? TypeHint<T[P]> : never
};

const bla = <T extends Field<any>[]>(alts: T): Unioned<T> => null as any

const ff = bla([stringField(), choiceField([1, 2, 3] as const), booleanField(), objectField({foo: stringField()})])
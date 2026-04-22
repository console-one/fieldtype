import { types } from "./builders.js"
import { FieldType } from "./type.js"

export const FunctionType = types.from({ 
  input: FieldType.any.nonce,
  output: FieldType.any.nonce,
  description: FieldType.string.nonce,
  meta: FieldType.object.nonce
})

export type FunctionTypeLike = {
  input: FieldType
  output: FieldType
  description: string
  meta: any
}

export const funcType = ({ input, output, description, template }: { input?: FieldType, output?: FieldType, description?: string, template?: { [key: string]: FieldType }}) => {
  let obj: any = {}
  if (input !== undefined) obj.input = input;
  if (output !== undefined) obj.output = output;
  let ftype = (template === undefined) ? types.extensionof(FunctionType, types.from(obj)) : types.extensionof(FunctionType, types.from(obj, template));
  if (description !== undefined) ftype = ftype.description("Some function that returns a queue key").save();
  return ftype;
}
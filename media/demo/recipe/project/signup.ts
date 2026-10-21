import { type } from "arktype"
import { validate } from "@spy4x/validation"

const Signup = type({ email: "string.email", age: "number >= 18" })

const { error } = validate(Signup, { email: "jane@", age: 16 })

console.log(error?.errors.email?.[0].message)
console.log(error?.errors.age?.[0].message)

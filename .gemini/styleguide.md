## Coding Conventions

- Write comments that explain "why" rather than "what". Avoid explanations that can be understood from the code itself.
- When adding new functions or classes, define them below any functions or classes that call them to maintain clear call order.
- Prefer `undefined` over `null` unless explicitly dealing with APIs or libraries that require `null`.
- Prefer `useImmer` for storing an array or an object to `useState`.
- Since this project uses the React Compiler, you do not need to use `useCallback` or `useMemo` for performance optimization.
- Assume there is only a single server instance.

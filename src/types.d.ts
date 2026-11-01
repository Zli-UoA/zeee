declare module '*.css';

declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}

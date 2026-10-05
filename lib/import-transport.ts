// Keep the complete HTTP request below the deployment's 4.5 MB ingress limit.
export const MAX_IMPORT_REQUEST_BYTES = 4 * 1024 * 1024;
// Leave room for multipart boundaries, the filename and other form fields.
export const MAX_IMPORT_FILE_BYTES = MAX_IMPORT_REQUEST_BYTES - 64 * 1024;

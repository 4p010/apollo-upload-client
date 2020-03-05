'use strict'

const { ApolloLink, Observable } = require('apollo-link')
const {
  selectURI,
  selectHttpOptionsAndBody,
  fallbackHttpConfig,
  serializeFetchParameter,
  createSignalIfSupported,
  parseAndCheckHttpResponse
} = require('apollo-link-http-common')
const {
  extractFiles,
  isExtractableFile,
  ReactNativeFile
} = require('extract-files')

/**
 * A React Native [`File`](https://developer.mozilla.org/docs/web/api/file)
 * substitute.
 *
 * Be aware that inspecting network requests with Chrome dev tools interferes
 * with the React Native `FormData` implementation, causing network errors.
 * @kind typedef
 * @name ReactNativeFileSubstitute
 * @type {object}
 * @see [`extract-files` docs](https://github.com/jaydenseric/extract-files#type-reactnativefilesubstitute).
 * @see [React Native `FormData` polyfill source](https://github.com/facebook/react-native/blob/v0.45.1/Libraries/Network/FormData.js#L34).
 * @prop {string} uri Filesystem path.
 * @prop {string} [name] File name.
 * @prop {string} [type] File content type. Some environments (particularly Android) require a valid MIME type; Expo `ImageResult.type` is unreliable as it can be just `image`.
 * @example <caption>A camera roll file.</caption>
 * ```js
 * {
 *   uri: uriFromCameraRoll,
 *   name: 'a.jpg',
 *   type: 'image/jpeg'
 * }
 * ```
 */

/**
 * Used to mark a
 * [React Native `File` substitute]{@link ReactNativeFileSubstitute}.
 * It’s too risky to assume all objects with `uri`, `type` and `name` properties
 * are files to extract. Re-exported from [`extract-files`](https://npm.im/extract-files)
 * for convenience.
 * @kind class
 * @name ReactNativeFile
 * @param {ReactNativeFileSubstitute} file A React Native [`File`](https://developer.mozilla.org/docs/web/api/file) substitute.
 * @example <caption>A React Native file that can be used in query or mutation variables.</caption>
 * ```js
 * const { ReactNativeFile } = require('apollo-upload-client')
 *
 * const file = new ReactNativeFile({
 *   uri: uriFromCameraRoll,
 *   name: 'a.jpg',
 *   type: 'image/jpeg'
 * })
 * ```
 */
exports.ReactNativeFile = ReactNativeFile

/**
 * GraphQL request `fetch` options.
 * @kind typedef
 * @name FetchOptions
 * @type {object}
 * @see [Polyfillable fetch options](https://github.github.io/fetch#options).
 * @prop {object} headers HTTP request headers.
 * @prop {string} [credentials] Authentication credentials mode.
 */

/**
 * Creates a terminating [Apollo Link](https://apollographql.com/docs/link)
 * capable of file uploads. Options match [`createHttpLink`](https://apollographql.com/docs/link/links/http#options).
 * @see [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec).
 * @see [apollo-link on GitHub](https://github.com/apollographql/apollo-link).
 * @kind function
 * @name createUploadLink
 * @param {object} options Options.
 * @param {string} [options.uri=/graphql] GraphQL endpoint URI.
 * @param {class} [options.FormData] [`FormData`](https://xhr.spec.whatwg.org/#interface-formdata) implementation to use, defaulting to the `FormData` global.
 * @param {Function} [options.appendFile] A function responsible for appending a file to an existing FormData object, defaulting to the exported `defaultAppendFile` function.
 * @param {Function} [options.isExtractableFile] A function to pass to [`extractFiles`](https://github.com/jaydenseric/extract-files#function-isextractablefile) to customize checking if a value is an extractable file.
 * @param {Function} [options.fetch] [`fetch`](https://fetch.spec.whatwg.org) implementation to use, defaulting to the `fetch` global.
 * @param {FetchOptions} [options.fetchOptions] `fetch` options; overridden by upload requirements.
 * @param {string} [options.credentials] Overrides `options.fetchOptions.credentials`.
 * @param {object} [options.headers] Merges with and overrides `options.fetchOptions.headers`.
 * @param {boolean} [options.includeExtensions=false] Toggles sending `extensions` fields to the GraphQL server.
 * @returns {ApolloLink} A terminating [Apollo Link](https://apollographql.com/docs/link) capable of file uploads.
 * @example <caption>A basic Apollo Client setup.</caption>
 * ```js
 * const { ApolloClient } = require('apollo-client')
 * const { InMemoryCache } = require('apollo-cache-inmemory')
 * const { createUploadLink } = require('apollo-upload-client')
 *
 * const client = new ApolloClient({
 *   cache: new InMemoryCache(),
 *   link: createUploadLink()
 * })
 * ```
 */
exports.createUploadLink = ({
  uri: fetchUri = '/graphql',
  FormData: CustomFormData = FormData,
  appendFile: customAppendFile = defaultAppendFile,
  isExtractableFile: customIsExtractableFile = isExtractableFile,
  fetch: customFetch = fetch,
  fetchOptions,
  credentials,
  headers,
  includeExtensions
} = {}) => {
  const linkConfig = {
    http: { includeExtensions },
    options: fetchOptions,
    credentials,
    headers
  }

  return new ApolloLink(operation => {
    const uri = selectURI(operation, fetchUri)
    const context = operation.getContext()

    // Apollo Engine client awareness:
    // https://apollographql.com/docs/platform/client-awareness

    const {
      // From Apollo Client config.
      clientAwareness: { name, version } = {},
      headers
    } = context

    const contextConfig = {
      http: context.http,
      options: context.fetchOptions,
      credentials: context.credentials,
      headers: {
        // Client awareness headers are context overridable.
        ...(name && { 'apollographql-client-name': name }),
        ...(version && { 'apollographql-client-version': version }),
        ...headers
      }
    }

    const { options, body } = selectHttpOptionsAndBody(
      operation,
      fallbackHttpConfig,
      linkConfig,
      contextConfig
    )

    const { clone, files } = extractFiles(body, '', customIsExtractableFile)
    const payload = serializeFetchParameter(clone, 'Payload')

    if (files.size) {
      // Automatically set by fetch when the body is a FormData instance.
      delete options.headers['content-type']

      // GraphQL multipart request spec:
      // https://github.com/jaydenseric/graphql-multipart-request-spec

      const form = new CustomFormData()

      form.append('operations', payload)

      const map = {}
      let i = 0
      files.forEach(paths => {
        map[++i] = paths
      })
      form.append('map', JSON.stringify(map))

      i = 0
      files.forEach((paths, file) => {
        customAppendFile(form, ++i, file)
      })

      options.body = form
    } else options.body = payload

    return new Observable(observer => {
      // If no abort controller signal was provided in fetch options, and the
      // environment supports the AbortController interface, create and use a
      // default abort controller.
      let abortController
      if (!options.signal) {
        const { controller } = createSignalIfSupported()
        if (controller) {
          abortController = controller
          options.signal = abortController.signal
        }
      }

      customFetch(uri, options)
        .then(response => {
          // Forward the response on the context.
          operation.setContext({ response })
          return response
        })
        .then(parseAndCheckHttpResponse(operation))
        .then(result => {
          observer.next(result)
          observer.complete()
        })
        .catch(error => {
          if (error.name === 'AbortError')
            // Fetch was aborted.
            return

          if (error.result && error.result.errors && error.result.data)
            // There is a GraphQL result to forward.
            observer.next(error.result)

          observer.error(error)
        })

      // Cleanup function.
      return () => {
        if (abortController)
          // Abort fetch.
          abortController.abort()
      }
    })
  })
}

/**
 * Adds a file to an existing multipart request. By default, simply appends the passed file without any special processing. The `name` property of the `file` object is used as the file name.
 * @kind function
 * @name defaultAppendFile
 * @param {object} form FormData object to which to append the specified file.
 * @param {string} name The name under which the file should be appended.
 * @param {object} file The file to be appended.
 * @returns {void}
 * @example <caption>Default appendFile function.</caption>
 * ```js
 * i = 0
 * files.forEach((paths, file) => {
 *   defaultAppendFile(form, ++i, file)
 * })
 * ```
 */
function defaultAppendFile(form, name, file) {
  form.append(name, file, file.name)
}
exports.defaultAppendFile = defaultAppendFile

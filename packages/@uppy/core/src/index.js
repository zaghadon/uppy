/* global AggregateError */
const Translator = require('@uppy/utils/lib/Translator')
const ee = require('namespace-emitter')
const { nanoid } = require('nanoid')
const throttle = require('lodash.throttle')
const prettierBytes = require('@transloadit/prettier-bytes')
const match = require('mime-match')
const DefaultStore = require('@uppy/store-default')
const getFileType = require('@uppy/utils/lib/getFileType')
const getFileNameAndExtension = require('@uppy/utils/lib/getFileNameAndExtension')
const generateFileID = require('@uppy/utils/lib/generateFileID')
const supportsUploadProgress = require('./supportsUploadProgress')
const getFileName = require('./getFileName')
const { justErrorsLogger, debugLogger } = require('./loggers')
const UIPlugin = require('./UIPlugin')
const BasePlugin = require('./BasePlugin')

// Exported from here.
class RestrictionError extends Error {
  constructor (...args) {
    super(...args)
    this.isRestriction = true
  }
}
if (typeof AggregateError === 'undefined') {
  // eslint-disable-next-line no-global-assign
  globalThis.AggregateError = class AggregateError extends Error {
    constructor (message, errors) {
      super(message)
      this.errors = errors
    }
  }
}
class AggregateRestrictionError extends AggregateError {
  constructor (...args) {
    super(...args)
    this.isRestriction = true
  }
}

/**
 * Uppy Core module.
 * Manages plugins, state updates, acts as an event bus,
 * adds/removes files and metadata.
 */
class Uppy {
  // eslint-disable-next-line global-require
  static VERSION = require('../package.json').version

  /** @type {Record<string, BasePlugin[]>} */
  #plugins = Object.create(null)

  #storeUnsubscribe

  #emitter = ee()

  #preProcessors = new Set()

  #uploaders = new Set()

  #postProcessors = new Set()

  /**
   * Instantiate Uppy
   *
   * @param {object} opts — Uppy options
   */
  constructor (opts) {
    this.defaultLocale = {
      strings: {
        addBulkFilesFailed: {
          0: 'Failed to add %{smart_count} file due to an internal error',
          1: 'Failed to add %{smart_count} files due to internal errors',
        },
        youCanOnlyUploadX: {
          0: 'You can only upload %{smart_count} file',
          1: 'You can only upload %{smart_count} files',
        },
        youHaveToAtLeastSelectX: {
          0: 'You have to select at least %{smart_count} file',
          1: 'You have to select at least %{smart_count} files',
        },
        exceedsSize: '%{file} exceeds maximum allowed size of %{size}',
        missingRequiredMetaField: 'Missing required meta fields',
        missingRequiredMetaFieldOnFile: 'Missing required meta fields in %{fileName}',
        inferiorSize: 'This file is smaller than the allowed size of %{size}',
        youCanOnlyUploadFileTypes: 'You can only upload: %{types}',
        noMoreFilesAllowed: 'Cannot add more files',
        noDuplicates: 'Cannot add the duplicate file \'%{fileName}\', it already exists',
        companionError: 'Connection with Companion failed',
        companionUnauthorizeHint: 'To unauthorize to your %{provider} account, please go to %{url}',
        failedToUpload: 'Failed to upload %{file}',
        noInternetConnection: 'No Internet connection',
        connectedToInternet: 'Connected to the Internet',
        // Strings for remote providers
        noFilesFound: 'You have no files or folders here',
        selectX: {
          0: 'Select %{smart_count}',
          1: 'Select %{smart_count}',
        },
        allFilesFromFolderNamed: 'All files from folder %{name}',
        openFolderNamed: 'Open folder %{name}',
        cancel: 'Cancel',
        logOut: 'Log out',
        filter: 'Filter',
        resetFilter: 'Reset filter',
        loading: 'Loading...',
        authenticateWithTitle: 'Please authenticate with %{pluginName} to select files',
        authenticateWith: 'Connect to %{pluginName}',
        signInWithGoogle: 'Sign in with Google',
        searchImages: 'Search for images',
        enterTextToSearch: 'Enter text to search for images',
        backToSearch: 'Back to Search',
        emptyFolderAdded: 'No files were added from empty folder',
        folderAlreadyAdded: 'The folder "%{folder}" was already added',
        folderAdded: {
          0: 'Added %{smart_count} file from %{folder}',
          1: 'Added %{smart_count} files from %{folder}',
        },
      },
    }

    const defaultOptions = {
      id: 'uppy',
      autoProceed: false,
      /**
       * @deprecated The method should not be used
       */
      allowMultipleUploads: true,
      allowMultipleUploadBatches: true,
      debug: false,
      restrictions: {
        maxFileSize: null,
        minFileSize: null,
        maxTotalFileSize: null,
        maxNumberOfFiles: null,
        minNumberOfFiles: null,
        allowedFileTypes: null,
        requiredMetaFields: [],
      },
      meta: {},
      onBeforeFileAdded: (currentFile) => currentFile,
      onBeforeUpload: (files) => files,
      store: DefaultStore(),
      logger: justErrorsLogger,
      infoTimeout: 5000,
    }

    // Merge default options with the ones set by user,
    // making sure to merge restrictions too
    this.opts = {
      ...defaultOptions,
      ...opts,
      restrictions: {
        ...defaultOptions.restrictions,
        ...(opts && opts.restrictions),
      },
    }

    // Support debug: true for backwards-compatability, unless logger is set in opts
    // opts instead of this.opts to avoid comparing objects — we set logger: justErrorsLogger in defaultOptions
    if (opts && opts.logger && opts.debug) {
      this.log('You are using a custom `logger`, but also set `debug: true`, which uses built-in logger to output logs to console. Ignoring `debug: true` and using your custom `logger`.', 'warning')
    } else if (opts && opts.debug) {
      this.opts.logger = debugLogger
    }

    this.log(`Using Core v${this.constructor.VERSION}`)

    if (this.opts.restrictions.allowedFileTypes
        && this.opts.restrictions.allowedFileTypes !== null
        && !Array.isArray(this.opts.restrictions.allowedFileTypes)) {
      throw new TypeError('`restrictions.allowedFileTypes` must be an array')
    }

    this.i18nInit()

    // ___Why throttle at 500ms?
    //    - We must throttle at >250ms for superfocus in Dashboard to work well
    //    (because animation takes 0.25s, and we want to wait for all animations to be over before refocusing).
    //    [Practical Check]: if thottle is at 100ms, then if you are uploading a file,
    //    and click 'ADD MORE FILES', - focus won't activate in Firefox.
    //    - We must throttle at around >500ms to avoid performance lags.
    //    [Practical Check] Firefox, try to upload a big file for a prolonged period of time. Laptop will start to heat up.
    this.calculateProgress = throttle(this.calculateProgress.bind(this), 500, { leading: true, trailing: true })

    this.store = this.opts.store
    this.setState({
      plugins: {},
      files: {},
      currentUploads: {},
      allowNewUpload: true,
      capabilities: {
        uploadProgress: supportsUploadProgress(),
        individualCancellation: true,
        resumableUploads: false,
      },
      totalProgress: 0,
      meta: { ...this.opts.meta },
      info: [],
      recoveredState: null,
    })

    this.#storeUnsubscribe = this.store.subscribe((prevState, nextState, patch) => {
      this.emit('state-update', prevState, nextState, patch)
      this.updateAll(nextState)
    })

    // Exposing uppy object on window for debugging and testing
    if (this.opts.debug && typeof window !== 'undefined') {
      window[this.opts.id] = this
    }

    this.#addListeners()
  }

  emit (event, ...args) {
    this.#emitter.emit(event, ...args)
  }

  on (event, callback) {
    this.#emitter.on(event, callback)
    return this
  }

  once (event, callback) {
    this.#emitter.once(event, callback)
    return this
  }

  off (event, callback) {
    this.#emitter.off(event, callback)
    return this
  }

  /**
   * Iterate on all plugins and run `update` on them.
   * Called each time state changes.
   *
   */
  updateAll (state) {
    this.iteratePlugins(plugin => {
      plugin.update(state)
    })
  }

  /**
   * Updates state with a patch
   *
   * @param {object} patch {foo: 'bar'}
   */
  setState (patch) {
    this.store.setState(patch)
  }

  /**
   * Returns current state.
   *
   * @returns {object}
   */
  getState () {
    return this.store.getState()
  }

  /**
   * Back compat for when uppy.state is used instead of uppy.getState().
   *
   * @deprecated
   */
  get state () {
    // Here, state is a non-enumerable property.
    return this.getState()
  }

  /**
   * Shorthand to set state for a specific file.
   */
  setFileState (fileID, state) {
    if (!this.getState().files[fileID]) {
      throw new Error(`Can’t set state for ${fileID} (the file could have been removed)`)
    }

    this.setState({
      files: { ...this.getState().files, [fileID]: { ...this.getState().files[fileID], ...state } },
    })
  }

  i18nInit () {
    const translator = new Translator([this.defaultLocale, this.opts.locale])
    this.i18n = translator.translate.bind(translator)
    this.i18nArray = translator.translateArray.bind(translator)
    this.locale = translator.locale
  }

  setOptions (newOpts) {
    this.opts = {
      ...this.opts,
      ...newOpts,
      restrictions: {
        ...this.opts.restrictions,
        ...(newOpts && newOpts.restrictions),
      },
    }

    if (newOpts.meta) {
      this.setMeta(newOpts.meta)
    }

    this.i18nInit()

    if (newOpts.locale) {
      this.iteratePlugins((plugin) => {
        plugin.setOptions()
      })
    }

    // Note: this is not the preact `setState`, it's an internal function that has the same name.
    this.setState() // so that UI re-renders with new options
  }

  resetProgress () {
    const defaultProgress = {
      percentage: 0,
      bytesUploaded: 0,
      uploadComplete: false,
      uploadStarted: null,
    }
    const files = { ...this.getState().files }
    const updatedFiles = {}
    Object.keys(files).forEach(fileID => {
      const updatedFile = { ...files[fileID] }
      updatedFile.progress = { ...updatedFile.progress, ...defaultProgress }
      updatedFiles[fileID] = updatedFile
    })

    this.setState({
      files: updatedFiles,
      totalProgress: 0,
    })

    this.emit('reset-progress')
  }

  addPreProcessor (fn) {
    this.#preProcessors.add(fn)
  }

  removePreProcessor (fn) {
    return this.#preProcessors.delete(fn)
  }

  addPostProcessor (fn) {
    this.#postProcessors.add(fn)
  }

  removePostProcessor (fn) {
    return this.#postProcessors.delete(fn)
  }

  addUploader (fn) {
    this.#uploaders.add(fn)
  }

  removeUploader (fn) {
    return this.#uploaders.delete(fn)
  }

  setMeta (data) {
    const updatedMeta = { ...this.getState().meta, ...data }
    const updatedFiles = { ...this.getState().files }

    Object.keys(updatedFiles).forEach((fileID) => {
      updatedFiles[fileID] = { ...updatedFiles[fileID], meta: { ...updatedFiles[fileID].meta, ...data } }
    })

    this.log('Adding metadata:')
    this.log(data)

    this.setState({
      meta: updatedMeta,
      files: updatedFiles,
    })
  }

  setFileMeta (fileID, data) {
    const updatedFiles = { ...this.getState().files }
    if (!updatedFiles[fileID]) {
      this.log('Was trying to set metadata for a file that has been removed: ', fileID)
      return
    }
    const newMeta = { ...updatedFiles[fileID].meta, ...data }
    updatedFiles[fileID] = { ...updatedFiles[fileID], meta: newMeta }
    this.setState({ files: updatedFiles })
  }

  /**
   * Get a file object.
   *
   * @param {string} fileID The ID of the file object to return.
   */
  getFile (fileID) {
    return this.getState().files[fileID]
  }

  /**
   * Get all files in an array.
   */
  getFiles () {
    const { files } = this.getState()
    return Object.values(files)
  }

  getObjectOfFilesPerState () {
    const { files: filesObject, totalProgress, error } = this.getState()
    const files = Object.values(filesObject)
    const inProgressFiles = files.filter(({ progress }) => !progress.uploadComplete && progress.uploadStarted)
    const newFiles =  files.filter((file) => !file.progress.uploadStarted)
    const startedFiles = files.filter(
      file => file.progress.uploadStarted || file.progress.preprocess || file.progress.postprocess
    )
    const uploadStartedFiles = files.filter((file) => file.progress.uploadStarted)
    const pausedFiles = files.filter((file) => file.isPaused)
    const completeFiles = files.filter((file) => file.progress.uploadComplete)
    const erroredFiles = files.filter((file) => file.error)
    const inProgressNotPausedFiles = inProgressFiles.filter((file) => !file.isPaused)
    const processingFiles = files.filter((file) => file.progress.preprocess || file.progress.postprocess)

    return {
      newFiles,
      startedFiles,
      uploadStartedFiles,
      pausedFiles,
      completeFiles,
      erroredFiles,
      inProgressFiles,
      inProgressNotPausedFiles,
      processingFiles,

      isUploadStarted: uploadStartedFiles.length > 0,
      isAllComplete: totalProgress === 100
        && completeFiles.length === files.length
        && processingFiles.length === 0,
      isAllErrored: !!error && erroredFiles.length === files.length,
      isAllPaused: inProgressFiles.length !== 0 && pausedFiles.length === inProgressFiles.length,
      isUploadInProgress: inProgressFiles.length > 0,
      isSomeGhost: files.some(file => file.isGhost),
    }
  }

  /**
   * A public wrapper for _checkRestrictions — checks if a file passes a set of restrictions.
   * For use in UI pluigins (like Providers), to disallow selecting files that won’t pass restrictions.
   *
   * @param {object} file object to check
   * @param {Array} [files] array to check maxNumberOfFiles and maxTotalFileSize
   * @returns {object} { result: true/false, reason: why file didn’t pass restrictions }
   */
  validateRestrictions (file, files) {
    try {
      this.#checkRestrictions(file, files)
      return {
        result: true,
      }
    } catch (err) {
      return {
        result: false,
        reason: err.message,
      }
    }
  }

  /**
   * Check if file passes a set of restrictions set in options: maxFileSize, minFileSize,
   * maxNumberOfFiles and allowedFileTypes.
   *
   * @param {object} file object to check
   * @param {Array} [files] array to check maxNumberOfFiles and maxTotalFileSize
   * @private
   */
  #checkRestrictions (file, files = this.getFiles()) {
    const { maxFileSize, minFileSize, maxTotalFileSize, maxNumberOfFiles, allowedFileTypes } = this.opts.restrictions

    if (maxNumberOfFiles) {
      if (files.length + 1 > maxNumberOfFiles) {
        throw new RestrictionError(`${this.i18n('youCanOnlyUploadX', { smart_count: maxNumberOfFiles })}`)
      }
    }

    if (allowedFileTypes) {
      const isCorrectFileType = allowedFileTypes.some((type) => {
        // check if this is a mime-type
        if (type.indexOf('/') > -1) {
          if (!file.type) return false
          return match(file.type.replace(/;.*?$/, ''), type)
        }

        // otherwise this is likely an extension
        if (type[0] === '.' && file.extension) {
          return file.extension.toLowerCase() === type.substr(1).toLowerCase()
        }
        return false
      })

      if (!isCorrectFileType) {
        const allowedFileTypesString = allowedFileTypes.join(', ')
        throw new RestrictionError(this.i18n('youCanOnlyUploadFileTypes', { types: allowedFileTypesString }))
      }
    }

    // We can't check maxTotalFileSize if the size is unknown.
    if (maxTotalFileSize && file.size != null) {
      let totalFilesSize = 0
      totalFilesSize += file.size
      files.forEach((f) => {
        totalFilesSize += f.size
      })
      if (totalFilesSize > maxTotalFileSize) {
        throw new RestrictionError(this.i18n('exceedsSize', {
          size: prettierBytes(maxTotalFileSize),
          file: file.name,
        }))
      }
    }

    // We can't check maxFileSize if the size is unknown.
    if (maxFileSize && file.size != null) {
      if (file.size > maxFileSize) {
        throw new RestrictionError(this.i18n('exceedsSize', {
          size: prettierBytes(maxFileSize),
          file: file.name,
        }))
      }
    }

    // We can't check minFileSize if the size is unknown.
    if (minFileSize && file.size != null) {
      if (file.size < minFileSize) {
        throw new RestrictionError(this.i18n('inferiorSize', {
          size: prettierBytes(minFileSize),
        }))
      }
    }
  }

  /**
   * Check if minNumberOfFiles restriction is reached before uploading.
   *
   * @private
   */
  #checkMinNumberOfFiles (files) {
    const { minNumberOfFiles } = this.opts.restrictions
    if (Object.keys(files).length < minNumberOfFiles) {
      throw new RestrictionError(`${this.i18n('youHaveToAtLeastSelectX', { smart_count: minNumberOfFiles })}`)
    }
  }

  /**
   * Check if requiredMetaField restriction is met before uploading.
   *
   */
  #checkRequiredMetaFields (files) {
    const { requiredMetaFields } = this.opts.restrictions
    const { hasOwnProperty } = Object.prototype

    const errors = []
    for (const fileID of Object.keys(files)) {
      const file = this.getFile(fileID)
      for (let i = 0; i < requiredMetaFields.length; i++) {
        if (!hasOwnProperty.call(file.meta, requiredMetaFields[i]) || file.meta[requiredMetaFields[i]] === '') {
          const err = new RestrictionError(`${this.i18n('missingRequiredMetaFieldOnFile', { fileName: file.name })}`)
          errors.push(err)
          this.#showOrLogErrorAndThrow(err, { file, showInformer: false, throwErr: false })
        }
      }
    }

    if (errors.length) {
      throw new AggregateRestrictionError(`${this.i18n('missingRequiredMetaField')}`, errors)
    }
  }

  /**
   * Logs an error, sets Informer message, then throws the error.
   * Emits a 'restriction-failed' event if it’s a restriction error
   *
   * @param {object | string} err — Error object or plain string message
   * @param {object} [options]
   * @param {boolean} [options.showInformer=true] — Sometimes developer might want to show Informer manually
   * @param {object} [options.file=null] — File object used to emit the restriction error
   * @param {boolean} [options.throwErr=true] — Errors shouldn’t be thrown, for example, in `upload-error` event
   * @private
   */
  #showOrLogErrorAndThrow (err, { showInformer = true, file = null, throwErr = true } = {}) {
    const message = typeof err === 'object' ? err.message : err
    const details = (typeof err === 'object' && err.details) ? err.details : ''

    // Restriction errors should be logged, but not as errors,
    // as they are expected and shown in the UI.
    let logMessageWithDetails = message
    if (details) {
      logMessageWithDetails += ` ${details}`
    }
    if (err.isRestriction) {
      this.log(logMessageWithDetails)
      this.emit('restriction-failed', file, err)
    } else {
      this.log(logMessageWithDetails, 'error')
    }

    // Sometimes informer has to be shown manually by the developer,
    // for example, in `onBeforeFileAdded`.
    if (showInformer) {
      this.info({ message, details }, 'error', this.opts.infoTimeout)
    }

    if (throwErr) {
      throw (typeof err === 'object' ? err : new Error(err))
    }
  }

  #assertNewUploadAllowed (file) {
    const { allowNewUpload } = this.getState()

    if (allowNewUpload === false) {
      this.#showOrLogErrorAndThrow(new RestrictionError(this.i18n('noMoreFilesAllowed')), { file })
    }
  }

  checkIfFileAlreadyExists (fileID) {
    const { files } = this.getState()

    if (files[fileID] && !files[fileID].isGhost) {
      return true
    }
    return false
  }

  /**
   * Create a file state object based on user-provided `addFile()` options.
   *
   * Note this is extremely side-effectful and should only be done when a file state object
   * will be added to state immediately afterward!
   *
   * The `files` value is passed in because it may be updated by the caller without updating the store.
   */
  #checkAndCreateFileStateObject (files, fileDescriptor) {
    const fileType = getFileType(fileDescriptor)
    const fileName = getFileName(fileType, fileDescriptor)
    const fileExtension = getFileNameAndExtension(fileName).extension
    const isRemote = Boolean(fileDescriptor.isRemote)
    const fileID = generateFileID({
      ...fileDescriptor,
      type: fileType,
    })

    if (this.checkIfFileAlreadyExists(fileID)) {
      const error = new RestrictionError(this.i18n('noDuplicates', { fileName }))
      this.#showOrLogErrorAndThrow(error, { file: fileDescriptor })
    }

    const meta = fileDescriptor.meta || {}
    meta.name = fileName
    meta.type = fileType

    // `null` means the size is unknown.
    const size = Number.isFinite(fileDescriptor.data.size) ? fileDescriptor.data.size : null

    let newFile = {
      source: fileDescriptor.source || '',
      id: fileID,
      name: fileName,
      extension: fileExtension || '',
      meta: {
        ...this.getState().meta,
        ...meta,
      },
      type: fileType,
      data: fileDescriptor.data,
      progress: {
        percentage: 0,
        bytesUploaded: 0,
        bytesTotal: size,
        uploadComplete: false,
        uploadStarted: null,
      },
      size,
      isRemote,
      remote: fileDescriptor.remote || '',
      preview: fileDescriptor.preview,
    }

    const onBeforeFileAddedResult = this.opts.onBeforeFileAdded(newFile, files)

    if (onBeforeFileAddedResult === false) {
      // Don’t show UI info for this error, as it should be done by the developer
      this.#showOrLogErrorAndThrow(new RestrictionError('Cannot add the file because onBeforeFileAdded returned false.'), { showInformer: false, fileDescriptor })
    } else if (typeof onBeforeFileAddedResult === 'object' && onBeforeFileAddedResult !== null) {
      newFile = onBeforeFileAddedResult
    }

    try {
      const filesArray = Object.keys(files).map(i => files[i])
      this.#checkRestrictions(newFile, filesArray)
    } catch (err) {
      this.#showOrLogErrorAndThrow(err, { file: newFile })
    }

    return newFile
  }

  // Schedule an upload if `autoProceed` is enabled.
  #startIfAutoProceed () {
    if (this.opts.autoProceed && !this.scheduledAutoProceed) {
      this.scheduledAutoProceed = setTimeout(() => {
        this.scheduledAutoProceed = null
        this.upload().catch((err) => {
          if (!err.isRestriction) {
            this.log(err.stack || err.message || err)
          }
        })
      }, 4)
    }
  }

  /**
   * Add a new file to `state.files`. This will run `onBeforeFileAdded`,
   * try to guess file type in a clever way, check file against restrictions,
   * and start an upload if `autoProceed === true`.
   *
   * @param {object} file object to add
   * @returns {string} id for the added file
   */
  addFile (file) {
    this.#assertNewUploadAllowed(file)

    const { files } = this.getState()
    let newFile = this.#checkAndCreateFileStateObject(files, file)

    // Users are asked to re-select recovered files without data,
    // and to keep the progress, meta and everthing else, we only replace said data
    if (files[newFile.id] && files[newFile.id].isGhost) {
      newFile = {
        ...files[newFile.id],
        data: file.data,
        isGhost: false,
      }
      this.log(`Replaced the blob in the restored ghost file: ${newFile.name}, ${newFile.id}`)
    }

    this.setState({
      files: {
        ...files,
        [newFile.id]: newFile,
      },
    })

    this.emit('file-added', newFile)
    this.emit('files-added', [newFile])
    this.log(`Added file: ${newFile.name}, ${newFile.id}, mime type: ${newFile.type}`)

    this.#startIfAutoProceed()

    return newFile.id
  }

  /**
   * Add multiple files to `state.files`. See the `addFile()` documentation.
   *
   * If an error occurs while adding a file, it is logged and the user is notified.
   * This is good for UI plugins, but not for programmatic use.
   * Programmatic users should usually still use `addFile()` on individual files.
   */
  addFiles (fileDescriptors) {
    this.#assertNewUploadAllowed()

    // create a copy of the files object only once
    const files = { ...this.getState().files }
    const newFiles = []
    const errors = []
    for (let i = 0; i < fileDescriptors.length; i++) {
      try {
        let newFile = this.#checkAndCreateFileStateObject(files, fileDescriptors[i])
        // Users are asked to re-select recovered files without data,
        // and to keep the progress, meta and everthing else, we only replace said data
        if (files[newFile.id] && files[newFile.id].isGhost) {
          newFile = {
            ...files[newFile.id],
            data: fileDescriptors[i].data,
            isGhost: false,
          }
          this.log(`Replaced blob in a ghost file: ${newFile.name}, ${newFile.id}`)
        }
        files[newFile.id] = newFile
        newFiles.push(newFile)
      } catch (err) {
        if (!err.isRestriction) {
          errors.push(err)
        }
      }
    }

    this.setState({ files })

    newFiles.forEach((newFile) => {
      this.emit('file-added', newFile)
    })

    this.emit('files-added', newFiles)

    if (newFiles.length > 5) {
      this.log(`Added batch of ${newFiles.length} files`)
    } else {
      Object.keys(newFiles).forEach(fileID => {
        this.log(`Added file: ${newFiles[fileID].name}\n id: ${newFiles[fileID].id}\n type: ${newFiles[fileID].type}`)
      })
    }

    if (newFiles.length > 0) {
      this.#startIfAutoProceed()
    }

    if (errors.length > 0) {
      let message = 'Multiple errors occurred while adding files:\n'
      errors.forEach((subError) => {
        message += `\n * ${subError.message}`
      })

      this.info({
        message: this.i18n('addBulkFilesFailed', { smart_count: errors.length }),
        details: message,
      }, 'error', this.opts.infoTimeout)

      if (typeof AggregateError === 'function') {
        throw new AggregateError(errors, message)
      } else {
        const err = new Error(message)
        err.errors = errors
        throw err
      }
    }
  }

  removeFiles (fileIDs, reason) {
    const { files, currentUploads } = this.getState()
    const updatedFiles = { ...files }
    const updatedUploads = { ...currentUploads }

    const removedFiles = Object.create(null)
    fileIDs.forEach((fileID) => {
      if (files[fileID]) {
        removedFiles[fileID] = files[fileID]
        delete updatedFiles[fileID]
      }
    })

    // Remove files from the `fileIDs` list in each upload.
    function fileIsNotRemoved (uploadFileID) {
      return removedFiles[uploadFileID] === undefined
    }

    Object.keys(updatedUploads).forEach((uploadID) => {
      const newFileIDs = currentUploads[uploadID].fileIDs.filter(fileIsNotRemoved)

      // Remove the upload if no files are associated with it anymore.
      if (newFileIDs.length === 0) {
        delete updatedUploads[uploadID]
        return
      }

      updatedUploads[uploadID] = {
        ...currentUploads[uploadID],
        fileIDs: newFileIDs,
      }
    })

    const stateUpdate = {
      currentUploads: updatedUploads,
      files: updatedFiles,
    }

    // If all files were removed - allow new uploads,
    // and clear recoveredState
    if (Object.keys(updatedFiles).length === 0) {
      stateUpdate.allowNewUpload = true
      stateUpdate.error = null
      stateUpdate.recoveredState = null
    }

    this.setState(stateUpdate)
    this.calculateTotalProgress()

    const removedFileIDs = Object.keys(removedFiles)
    removedFileIDs.forEach((fileID) => {
      this.emit('file-removed', removedFiles[fileID], reason)
    })

    if (removedFileIDs.length > 5) {
      this.log(`Removed ${removedFileIDs.length} files`)
    } else {
      this.log(`Removed files: ${removedFileIDs.join(', ')}`)
    }
  }

  removeFile (fileID, reason = null) {
    this.removeFiles([fileID], reason)
  }

  pauseResume (fileID) {
    if (!this.getState().capabilities.resumableUploads
         || this.getFile(fileID).uploadComplete) {
      return undefined
    }

    const wasPaused = this.getFile(fileID).isPaused || false
    const isPaused = !wasPaused

    this.setFileState(fileID, {
      isPaused,
    })

    this.emit('upload-pause', fileID, isPaused)

    return isPaused
  }

  pauseAll () {
    const updatedFiles = { ...this.getState().files }
    const inProgressUpdatedFiles = Object.keys(updatedFiles).filter((file) => {
      return !updatedFiles[file].progress.uploadComplete
             && updatedFiles[file].progress.uploadStarted
    })

    inProgressUpdatedFiles.forEach((file) => {
      const updatedFile = { ...updatedFiles[file], isPaused: true }
      updatedFiles[file] = updatedFile
    })

    this.setState({ files: updatedFiles })
    this.emit('pause-all')
  }

  resumeAll () {
    const updatedFiles = { ...this.getState().files }
    const inProgressUpdatedFiles = Object.keys(updatedFiles).filter((file) => {
      return !updatedFiles[file].progress.uploadComplete
             && updatedFiles[file].progress.uploadStarted
    })

    inProgressUpdatedFiles.forEach((file) => {
      const updatedFile = {
        ...updatedFiles[file],
        isPaused: false,
        error: null,
      }
      updatedFiles[file] = updatedFile
    })
    this.setState({ files: updatedFiles })

    this.emit('resume-all')
  }

  retryAll () {
    const updatedFiles = { ...this.getState().files }
    const filesToRetry = Object.keys(updatedFiles).filter(file => {
      return updatedFiles[file].error
    })

    filesToRetry.forEach((file) => {
      const updatedFile = {
        ...updatedFiles[file],
        isPaused: false,
        error: null,
      }
      updatedFiles[file] = updatedFile
    })
    this.setState({
      files: updatedFiles,
      error: null,
    })

    this.emit('retry-all', filesToRetry)

    if (filesToRetry.length === 0) {
      return Promise.resolve({
        successful: [],
        failed: [],
      })
    }

    const uploadID = this.#createUpload(filesToRetry, {
      forceAllowNewUpload: true, // create new upload even if allowNewUpload: false
    })
    return this.#runUpload(uploadID)
  }

  cancelAll () {
    this.emit('cancel-all')

    const { files } = this.getState()

    const fileIDs = Object.keys(files)
    if (fileIDs.length) {
      this.removeFiles(fileIDs, 'cancel-all')
    }

    this.setState({
      totalProgress: 0,
      error: null,
      recoveredState: null,
    })
  }

  retryUpload (fileID) {
    this.setFileState(fileID, {
      error: null,
      isPaused: false,
    })

    this.emit('upload-retry', fileID)

    const uploadID = this.#createUpload([fileID], {
      forceAllowNewUpload: true, // create new upload even if allowNewUpload: false
    })
    return this.#runUpload(uploadID)
  }

  reset () {
    this.cancelAll()
  }

  logout () {
    this.iteratePlugins(plugin => {
      if (plugin.provider && plugin.provider.logout) {
        plugin.provider.logout()
      }
    })
  }

  calculateProgress (file, data) {
    if (!this.getFile(file.id)) {
      this.log(`Not setting progress for a file that has been removed: ${file.id}`)
      return
    }

    // bytesTotal may be null or zero; in that case we can't divide by it
    const canHavePercentage = Number.isFinite(data.bytesTotal) && data.bytesTotal > 0
    this.setFileState(file.id, {
      progress: {
        ...this.getFile(file.id).progress,
        bytesUploaded: data.bytesUploaded,
        bytesTotal: data.bytesTotal,
        percentage: canHavePercentage
          ? Math.round((data.bytesUploaded / data.bytesTotal) * 100)
          : 0,
      },
    })

    this.calculateTotalProgress()
  }

  calculateTotalProgress () {
    // calculate total progress, using the number of files currently uploading,
    // multiplied by 100 and the summ of individual progress of each file
    const files = this.getFiles()

    const inProgress = files.filter((file) => {
      return file.progress.uploadStarted
        || file.progress.preprocess
        || file.progress.postprocess
    })

    if (inProgress.length === 0) {
      this.emit('progress', 0)
      this.setState({ totalProgress: 0 })
      return
    }

    const sizedFiles = inProgress.filter((file) => file.progress.bytesTotal != null)
    const unsizedFiles = inProgress.filter((file) => file.progress.bytesTotal == null)

    if (sizedFiles.length === 0) {
      const progressMax = inProgress.length * 100
      const currentProgress = unsizedFiles.reduce((acc, file) => {
        return acc + file.progress.percentage
      }, 0)
      const totalProgress = Math.round((currentProgress / progressMax) * 100)
      this.setState({ totalProgress })
      return
    }

    let totalSize = sizedFiles.reduce((acc, file) => {
      return acc + file.progress.bytesTotal
    }, 0)
    const averageSize = totalSize / sizedFiles.length
    totalSize += averageSize * unsizedFiles.length

    let uploadedSize = 0
    sizedFiles.forEach((file) => {
      uploadedSize += file.progress.bytesUploaded
    })
    unsizedFiles.forEach((file) => {
      uploadedSize += (averageSize * (file.progress.percentage || 0)) / 100
    })

    let totalProgress = totalSize === 0
      ? 0
      : Math.round((uploadedSize / totalSize) * 100)

    // hot fix, because:
    // uploadedSize ended up larger than totalSize, resulting in 1325% total
    if (totalProgress > 100) {
      totalProgress = 100
    }

    this.setState({ totalProgress })
    this.emit('progress', totalProgress)
  }

  /**
   * Registers listeners for all global actions, like:
   * `error`, `file-removed`, `upload-progress`
   */
  #addListeners () {
    /**
     * @param {Error} error
     * @param {object} [file]
     * @param {object} [response]
     */
    const errorHandler = (error, file, response) => {
      let errorMsg = error.message || 'Unknown error'
      if (error.details) {
        errorMsg += ` ${error.details}`
      }

      this.setState({ error: errorMsg })

      if (file != null && file.id in this.getState().files) {
        this.setFileState(file.id, {
          error: errorMsg,
          response,
        })
      }
    }

    this.on('error', errorHandler)

    this.on('upload-error', (file, error, response) => {
      errorHandler(error, file, response)

      if (typeof error === 'object' && error.message) {
        const newError = new Error(error.message)
        newError.details = error.message
        if (error.details) {
          newError.details += ` ${error.details}`
        }
        newError.message = this.i18n('failedToUpload', { file: file.name })
        this.#showOrLogErrorAndThrow(newError, {
          throwErr: false,
        })
      } else {
        this.#showOrLogErrorAndThrow(error, {
          throwErr: false,
        })
      }
    })

    this.on('upload', () => {
      this.setState({ error: null })
    })

    this.on('upload-started', (file) => {
      if (!this.getFile(file.id)) {
        this.log(`Not setting progress for a file that has been removed: ${file.id}`)
        return
      }
      this.setFileState(file.id, {
        progress: {
          uploadStarted: Date.now(),
          uploadComplete: false,
          percentage: 0,
          bytesUploaded: 0,
          bytesTotal: file.size,
        },
      })
    })

    this.on('upload-progress', this.calculateProgress)

    this.on('upload-success', (file, uploadResp) => {
      if (!this.getFile(file.id)) {
        this.log(`Not setting progress for a file that has been removed: ${file.id}`)
        return
      }

      const currentProgress = this.getFile(file.id).progress
      this.setFileState(file.id, {
        progress: {
          ...currentProgress,
          postprocess: this.#postProcessors.size > 0 ? {
            mode: 'indeterminate',
          } : null,
          uploadComplete: true,
          percentage: 100,
          bytesUploaded: currentProgress.bytesTotal,
        },
        response: uploadResp,
        uploadURL: uploadResp.uploadURL,
        isPaused: false,
      })

      // Remote providers sometimes don't tell us the file size,
      // but we can know how many bytes we uploaded once the upload is complete.
      if (file.size == null) {
        this.setFileState(file.id, {
          size: uploadResp.bytesUploaded || currentProgress.bytesTotal,
        })
      }

      this.calculateTotalProgress()
    })

    this.on('preprocess-progress', (file, progress) => {
      if (!this.getFile(file.id)) {
        this.log(`Not setting progress for a file that has been removed: ${file.id}`)
        return
      }
      this.setFileState(file.id, {
        progress: { ...this.getFile(file.id).progress, preprocess: progress },
      })
    })

    this.on('preprocess-complete', (file) => {
      if (!this.getFile(file.id)) {
        this.log(`Not setting progress for a file that has been removed: ${file.id}`)
        return
      }
      const files = { ...this.getState().files }
      files[file.id] = { ...files[file.id], progress: { ...files[file.id].progress } }
      delete files[file.id].progress.preprocess

      this.setState({ files })
    })

    this.on('postprocess-progress', (file, progress) => {
      if (!this.getFile(file.id)) {
        this.log(`Not setting progress for a file that has been removed: ${file.id}`)
        return
      }
      this.setFileState(file.id, {
        progress: { ...this.getState().files[file.id].progress, postprocess: progress },
      })
    })

    this.on('postprocess-complete', (file) => {
      if (!this.getFile(file.id)) {
        this.log(`Not setting progress for a file that has been removed: ${file.id}`)
        return
      }
      const files = {
        ...this.getState().files,
      }
      files[file.id] = {
        ...files[file.id],
        progress: {
          ...files[file.id].progress,
        },
      }
      delete files[file.id].progress.postprocess

      this.setState({ files })
    })

    this.on('restored', () => {
      // Files may have changed--ensure progress is still accurate.
      this.calculateTotalProgress()
    })

    // show informer if offline
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', this.#updateOnlineStatus)
      window.addEventListener('offline', this.#updateOnlineStatus)
      setTimeout(this.#updateOnlineStatus, 3000)
    }
  }

  updateOnlineStatus () {
    const online
      = typeof window.navigator.onLine !== 'undefined'
        ? window.navigator.onLine
        : true
    if (!online) {
      this.emit('is-offline')
      this.info(this.i18n('noInternetConnection'), 'error', 0)
      this.wasOffline = true
    } else {
      this.emit('is-online')
      if (this.wasOffline) {
        this.emit('back-online')
        this.info(this.i18n('connectedToInternet'), 'success', 3000)
        this.wasOffline = false
      }
    }
  }

  #updateOnlineStatus = this.updateOnlineStatus.bind(this)

  getID () {
    return this.opts.id
  }

  /**
   * Registers a plugin with Core.
   *
   * @param {object} Plugin object
   * @param {object} [opts] object with options to be passed to Plugin
   * @returns {object} self for chaining
   */
  // eslint-disable-next-line no-shadow
  use (Plugin, opts) {
    if (typeof Plugin !== 'function') {
      const msg = `Expected a plugin class, but got ${Plugin === null ? 'null' : typeof Plugin}.`
        + ' Please verify that the plugin was imported and spelled correctly.'
      throw new TypeError(msg)
    }

    // Instantiate
    const plugin = new Plugin(this, opts)
    const pluginId = plugin.id

    if (!pluginId) {
      throw new Error('Your plugin must have an id')
    }

    if (!plugin.type) {
      throw new Error('Your plugin must have a type')
    }

    const existsPluginAlready = this.getPlugin(pluginId)
    if (existsPluginAlready) {
      const msg = `Already found a plugin named '${existsPluginAlready.id}'. `
        + `Tried to use: '${pluginId}'.\n`
        + 'Uppy plugins must have unique `id` options. See https://uppy.io/docs/plugins/#id.'
      throw new Error(msg)
    }

    if (Plugin.VERSION) {
      this.log(`Using ${pluginId} v${Plugin.VERSION}`)
    }

    if (plugin.type in this.#plugins) {
      this.#plugins[plugin.type].push(plugin)
    } else {
      this.#plugins[plugin.type] = [plugin]
    }
    plugin.install()

    return this
  }

  /**
   * Find one Plugin by name.
   *
   * @param {string} id plugin id
   * @returns {BasePlugin|undefined}
   */
  getPlugin (id) {
    for (const plugins of Object.values(this.#plugins)) {
      const foundPlugin = plugins.find(plugin => plugin.id === id)
      if (foundPlugin != null) return foundPlugin
    }
    return undefined
  }

  [Symbol.for('uppy test: getPlugins')] (type) {
    return this.#plugins[type]
  }

  /**
   * Iterate through all `use`d plugins.
   *
   * @param {Function} method that will be run on each plugin
   */
  iteratePlugins (method) {
    Object.values(this.#plugins).flat(1).forEach(method)
  }

  /**
   * Uninstall and remove a plugin.
   *
   * @param {object} instance The plugin instance to remove.
   */
  removePlugin (instance) {
    this.log(`Removing plugin ${instance.id}`)
    this.emit('plugin-remove', instance)

    if (instance.uninstall) {
      instance.uninstall()
    }

    const list = this.#plugins[instance.type]
    // list.indexOf failed here, because Vue3 converted the plugin instance
    // to a Proxy object, which failed the strict comparison test:
    // obj !== objProxy
    const index = list.findIndex(item => item.id === instance.id)
    if (index !== -1) {
      list.splice(index, 1)
    }

    const state = this.getState()
    const updatedState = {
      plugins: {
        ...state.plugins,
        [instance.id]: undefined,
      },
    }
    this.setState(updatedState)
  }

  /**
   * Uninstall all plugins and close down this Uppy instance.
   */
  close () {
    this.log(`Closing Uppy instance ${this.opts.id}: removing all files and uninstalling plugins`)

    this.reset()

    this.#storeUnsubscribe()

    this.iteratePlugins((plugin) => {
      this.removePlugin(plugin)
    })

    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('online', this.#updateOnlineStatus)
      window.removeEventListener('offline', this.#updateOnlineStatus)
    }
  }

  hideInfo () {
    const { info } = this.getState()

    this.setState({ info: info.slice(1) })

    this.emit('info-hidden')
  }

  /**
   * Set info message in `state.info`, so that UI plugins like `Informer`
   * can display the message.
   *
   * @param {string | object} message Message to be displayed by the informer
   * @param {string} [type]
   * @param {number} [duration]
   */
  info (message, type = 'info', duration = 3000) {
    const isComplexMessage = typeof message === 'object'

    this.setState({
      info: [
        ...this.getState().info,
        {
          type,
          message: isComplexMessage ? message.message : message,
          details: isComplexMessage ? message.details : null,
        },
      ],
    })

    setTimeout(() => this.hideInfo(), duration)

    this.emit('info-visible')
  }

  /**
   * Passes messages to a function, provided in `opts.logger`.
   * If `opts.logger: Uppy.debugLogger` or `opts.debug: true`, logs to the browser console.
   *
   * @param {string|object} message to log
   * @param {string} [type] optional `error` or `warning`
   */
  log (message, type) {
    const { logger } = this.opts
    switch (type) {
      case 'error': logger.error(message); break
      case 'warning': logger.warn(message); break
      default: logger.debug(message); break
    }
  }

  /**
   * Restore an upload by its ID.
   */
  restore (uploadID) {
    this.log(`Core: attempting to restore upload "${uploadID}"`)

    if (!this.getState().currentUploads[uploadID]) {
      this.#removeUpload(uploadID)
      return Promise.reject(new Error('Nonexistent upload'))
    }

    return this.#runUpload(uploadID)
  }

  /**
   * Create an upload for a bunch of files.
   *
   * @param {Array<string>} fileIDs File IDs to include in this upload.
   * @returns {string} ID of this upload.
   */
  #createUpload (fileIDs, opts = {}) {
    // uppy.retryAll sets this to true — when retrying we want to ignore `allowNewUpload: false`
    const { forceAllowNewUpload = false } = opts

    const { allowNewUpload, currentUploads } = this.getState()
    if (!allowNewUpload && !forceAllowNewUpload) {
      throw new Error('Cannot create a new upload: already uploading.')
    }

    const uploadID = nanoid()

    this.emit('upload', {
      id: uploadID,
      fileIDs,
    })

    this.setState({
      allowNewUpload: this.opts.allowMultipleUploadBatches !== false && this.opts.allowMultipleUploads !== false,

      currentUploads: {
        ...currentUploads,
        [uploadID]: {
          fileIDs,
          step: 0,
          result: {},
        },
      },
    })

    return uploadID
  }

  [Symbol.for('uppy test: createUpload')] (...args) { return this.#createUpload(...args) }

  #getUpload (uploadID) {
    const { currentUploads } = this.getState()

    return currentUploads[uploadID]
  }

  /**
   * Add data to an upload's result object.
   *
   * @param {string} uploadID The ID of the upload.
   * @param {object} data Data properties to add to the result object.
   */
  addResultData (uploadID, data) {
    if (!this.#getUpload(uploadID)) {
      this.log(`Not setting result for an upload that has been removed: ${uploadID}`)
      return
    }
    const { currentUploads } = this.getState()
    const currentUpload = { ...currentUploads[uploadID], result: { ...currentUploads[uploadID].result, ...data } }
    this.setState({
      currentUploads: { ...currentUploads, [uploadID]: currentUpload },
    })
  }

  /**
   * Remove an upload, eg. if it has been canceled or completed.
   *
   * @param {string} uploadID The ID of the upload.
   */
  #removeUpload (uploadID) {
    const currentUploads = { ...this.getState().currentUploads }
    delete currentUploads[uploadID]

    this.setState({
      currentUploads,
    })
  }

  /**
   * Run an upload. This picks up where it left off in case the upload is being restored.
   *
   * @private
   */
  async #runUpload (uploadID) {
    let { currentUploads } = this.getState()
    let currentUpload = currentUploads[uploadID]
    const restoreStep = currentUpload.step || 0

    const steps = [
      ...this.#preProcessors,
      ...this.#uploaders,
      ...this.#postProcessors,
    ]
    try {
      for (let step = restoreStep; step < steps.length; step++) {
        if (!currentUpload) {
          break
        }
        const fn = steps[step]

        const updatedUpload = {
          ...currentUpload,
          step,
        }

        this.setState({
          currentUploads: {
            ...currentUploads,
            [uploadID]: updatedUpload,
          },
        })

        // TODO give this the `updatedUpload` object as its only parameter maybe?
        // Otherwise when more metadata may be added to the upload this would keep getting more parameters
        await fn(updatedUpload.fileIDs, uploadID)

        // Update currentUpload value in case it was modified asynchronously.
        currentUploads = this.getState().currentUploads
        currentUpload = currentUploads[uploadID]
      }
    } catch (err) {
      this.emit('error', err)
      this.#removeUpload(uploadID)
      throw err
    }

    // Set result data.
    if (currentUpload) {
      // Mark postprocessing step as complete if necessary; this addresses a case where we might get
      // stuck in the postprocessing UI while the upload is fully complete.
      // If the postprocessing steps do not do any work, they may not emit postprocessing events at
      // all, and never mark the postprocessing as complete. This is fine on its own but we
      // introduced code in the @uppy/core upload-success handler to prepare postprocessing progress
      // state if any postprocessors are registered. That is to avoid a "flash of completed state"
      // before the postprocessing plugins can emit events.
      //
      // So, just in case an upload with postprocessing plugins *has* completed *without* emitting
      // postprocessing completion, we do it instead.
      currentUpload.fileIDs.forEach((fileID) => {
        const file = this.getFile(fileID)
        if (file && file.progress.postprocess) {
          this.emit('postprocess-complete', file)
        }
      })

      const files = currentUpload.fileIDs.map((fileID) => this.getFile(fileID))
      const successful = files.filter((file) => !file.error)
      const failed = files.filter((file) => file.error)
      await this.addResultData(uploadID, { successful, failed, uploadID })

      // Update currentUpload value in case it was modified asynchronously.
      currentUploads = this.getState().currentUploads
      currentUpload = currentUploads[uploadID]
    }
    // Emit completion events.
    // This is in a separate function so that the `currentUploads` variable
    // always refers to the latest state. In the handler right above it refers
    // to an outdated object without the `.result` property.
    let result
    if (currentUpload) {
      result = currentUpload.result
      this.emit('complete', result)

      this.#removeUpload(uploadID)
    }
    if (result == null) {
      this.log(`Not setting result for an upload that has been removed: ${uploadID}`)
    }
    return result
  }

  /**
   * Start an upload for all the files that are not currently being uploaded.
   *
   * @returns {Promise}
   */
  upload () {
    if (!this.#plugins.uploader?.length) {
      this.log('No uploader type plugins are used', 'warning')
    }

    let { files } = this.getState()

    const onBeforeUploadResult = this.opts.onBeforeUpload(files)

    if (onBeforeUploadResult === false) {
      return Promise.reject(new Error('Not starting the upload because onBeforeUpload returned false'))
    }

    if (onBeforeUploadResult && typeof onBeforeUploadResult === 'object') {
      files = onBeforeUploadResult
      // Updating files in state, because uploader plugins receive file IDs,
      // and then fetch the actual file object from state
      this.setState({
        files,
      })
    }

    return Promise.resolve()
      .then(() => {
        this.#checkMinNumberOfFiles(files)
        this.#checkRequiredMetaFields(files)
      })
      .catch((err) => {
        this.#showOrLogErrorAndThrow(err)
      })
      .then(() => {
        const { currentUploads } = this.getState()
        // get a list of files that are currently assigned to uploads
        const currentlyUploadingFiles = Object.values(currentUploads).flatMap(curr => curr.fileIDs)

        const waitingFileIDs = []
        Object.keys(files).forEach((fileID) => {
          const file = this.getFile(fileID)
          // if the file hasn't started uploading and hasn't already been assigned to an upload..
          if ((!file.progress.uploadStarted) && (currentlyUploadingFiles.indexOf(fileID) === -1)) {
            waitingFileIDs.push(file.id)
          }
        })

        const uploadID = this.#createUpload(waitingFileIDs)
        return this.#runUpload(uploadID)
      })
      .catch((err) => {
        this.#showOrLogErrorAndThrow(err, {
          showInformer: false,
        })
      })
  }
}

// Expose class constructor.
module.exports = Uppy
module.exports.Uppy = Uppy
module.exports.UIPlugin = UIPlugin
module.exports.BasePlugin = BasePlugin
module.exports.debugLogger = debugLogger

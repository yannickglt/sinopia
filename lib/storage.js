var assert    = require('assert')
var async     = require('async')
var Error     = require('http-errors')
var Local     = require('./local-storage')
var Logger    = require('./logger')
var MyStreams = require('./streams')
var Proxy     = require('./up-storage')
var Utils     = require('./utils')

module.exports = Storage

//
// Implements Storage interface
// (same for storage.js, local-storage.js, up-storage.js)
//
function Storage(config) {
  var self = Object.create(Storage.prototype)
  self.config = config

  // we support a number of uplinks, but only one local storage
  // Proxy and Local classes should have similar API interfaces
  self.uplinks = {}
  for (var p in config.uplinks) {
    self.uplinks[p] = Proxy(config.uplinks[p], config)
    self.uplinks[p].upname = p
  }
  self.local = Local(config)
  self.logger = Logger.logger.child()

  return self
}

//
// Add a {name} package to a system
//
// Function checks if package with the same name is available from uplinks.
// If it isn't, we create package locally
//
// Used storages: local (write) && uplinks
//
Storage.prototype.add_package = function(name, metadata, callback) {
  var self = this

  // NOTE:
  // - when we checking package for existance, we ask ALL uplinks
  // - when we publishing package, we only publish it to some of them
  // so all requests are necessary

  check_package_local(function(err) {
    if (err) return callback(err)

    check_package_remote(function(err) {
      if (err) return callback(err)

      publish_package(function(err) {
        if (err) return callback(err)
        callback()
      })
    })
  })

  function check_package_local(cb) {
    self.local.get_package(name, {}, function(err, results) {
      if (err && err.status !== 404) return cb(err)

      if (results) return cb( Error[409]('this package is already present') )

      cb()
    })
  }

  function check_package_remote(cb) {
    self._sync_package_with_uplinks(name, null, {}, function(err, results, err_results) {
      // something weird
      if (err && err.status !== 404) return cb(err)

      // checking package
      if (results) return cb( Error[409]('this package is already present') )

      for (var i=0; i<err_results.length; i++) {
        // checking error
        // if uplink fails with a status other than 404, we report failure
        if (err_results[i][0] != null) {
          if (err_results[i][0].status !== 404) {
            return cb( Error[503]('one of the uplinks is down, refuse to publish') )
          }
        }
      }

      return cb()
    })
  }

  function publish_package(cb) {
    self.local.add_package(name, metadata, callback)
  }
}

//
// Add a new version of package {name} to a system
//
// Used storages: local (write)
//
Storage.prototype.add_version = function(name, version, metadata, tag, callback) {
  return this.local.add_version(name, version, metadata, tag, callback)
}

//
// Tags a package version with a provided tag
//
// Used storages: local (write)
//
Storage.prototype.add_tags = function(name, tag_hash, callback) {
  return this.local.add_tags(name, tag_hash, callback)
}

//
// Change an existing package (i.e. unpublish one version)
//
// Function changes a package info from local storage and all uplinks with
// write access.
//
// Used storages: local (write)
//
Storage.prototype.change_package = function(name, metadata, revision, callback) {
  return this.local.change_package(name, metadata, revision, callback)
}

//
// Remove a package from a system
//
// Function removes a package from local storage
//
// Used storages: local (write)
//
Storage.prototype.remove_package = function(name, callback) {
  return this.local.remove_package(name, callback)
}

//
// Remove a tarball from a system
//
// Function removes a tarball from local storage.
// Tarball in question should not be linked to in any existing
// versions, i.e. package version should be unpublished first.
//
// Used storages: local (write)
//
Storage.prototype.remove_tarball = function(name, filename, revision, callback) {
  return this.local.remove_tarball(name, filename, revision, callback)
}

//
// Upload a tarball for {name} package
//
// Function is syncronous and returns a WritableStream
//
// Used storages: local (write)
//
Storage.prototype.add_tarball = function(name, filename) {
  return this.local.add_tarball(name, filename)
}

//
// Get a tarball from a storage for {name} package
//
// Function is syncronous and returns a ReadableStream
//
// Function tries to read tarball locally, if it fails then it reads package
// information in order to figure out where we can get this tarball from
//
// Used storages: local || uplink (just one)
//
Storage.prototype.get_tarball = function(name, filename) {
  var stream = MyStreams.ReadTarballStream()
  stream.abort = function() {}

  var self = this

  // if someone requesting tarball, it means that we should already have some
  // information about it, so fetching package info is unnecessary

  // trying local first
  var rstream = self.local.get_tarball(name, filename)
  var is_open = false
  rstream.on('error', function(err) {
    if (is_open || err.status !== 404) {
      return stream.emit('error', err)
    }

    // local reported 404
    var err404 = err
    var uplink = null
    rstream.abort()
    rstream = null // gc

    self.local.get_package(name, function(err, info) {
      if (!err && info._distfiles && info._distfiles[filename] != null) {
        // information about this file exists locally
        serve_file(info._distfiles[filename])

      } else {
        // we know nothing about this file, trying to get information elsewhere

        self._sync_package_with_uplinks(name, info, {}, function(err, info) {
          if (err) return stream.emit('error', err)

          if (!info._distfiles || info._distfiles[filename] == null) {
            return stream.emit('error', err404)
          }

          serve_file(info._distfiles[filename])
        })
      }
    })
  })
  rstream.on('content-length', function(v) {
    stream.emit('content-length', v)
  })
  rstream.on('open', function() {
    is_open = true
    rstream.pipe(stream)
  })
  return stream

  function serve_file(file) {
    var uplink = null
    for (var p in self.uplinks) {
      if (self.uplinks[p].can_fetch_url(file.url)) {
        uplink = self.uplinks[p]
      }
    }
    if (uplink == null) {
      uplink = Proxy({
        url: file.url,
        _autogenerated: true,
      }, self.config)
    }

    var savestream = self.local.add_tarball(name, filename)
    var on_open = function() {
      on_open = function(){} // prevent it from being called twice
      var rstream2 = uplink.get_url(file.url)
      rstream2.on('error', function(err) {
        if (savestream) savestream.abort()
        savestream = null
        stream.emit('error', err)
      })
      rstream2.on('end', function() {
        if (savestream) savestream.done()
      })

      rstream2.on('content-length', function(v) {
        stream.emit('content-length', v)
        if (savestream) savestream.emit('content-length', v)
      })
      rstream2.pipe(stream)
      if (savestream) rstream2.pipe(savestream)
    }

    savestream.on('open', function() {
      on_open()
    })
    savestream.on('error', function(err) {
      self.logger.warn( { err: err }
                      , 'error saving file: @{err.message}\n@{err.stack}' )
      if (savestream) savestream.abort()
      savestream = null
      on_open()
    })
  }
}

//
// Retrieve a package metadata for {name} package
//
// Function invokes local.get_package and uplink.get_package for every
// uplink with proxy_access rights against {name} and combines results
// into one json object
//
// Used storages: local && uplink (proxy_access)
//
Storage.prototype.get_package = function(name, options, callback) {
  if (typeof(options) === 'function') callback = options, options = {}

  var self = this

  self.local.get_package(name, options, function(err, data) {
    if (err && (!err.status || err.status >= 500)) {
      // report internal errors right away
      return callback(err)
    }

    self._sync_package_with_uplinks(name, data, options, function(err, result, uplink_errors) {
      if (err) return callback(err)
      var whitelist = [ '_rev', 'name', 'versions', 'dist-tags', 'readme' ]
      for (var i in result) {
        if (whitelist.indexOf(i) === -1) delete result[i]
      }

      if (self.config.ignore_latest_tag || !result['dist-tags'].latest) {
        result['dist-tags'].latest = Utils.semver_sort(Object.keys(result.versions))
      }

      for (var i in result['dist-tags']) {
        if (Array.isArray(result['dist-tags'][i])) {
          result['dist-tags'][i] = result['dist-tags'][i][result['dist-tags'][i].length-1]
          if (result['dist-tags'][i] == null) delete result['dist-tags'][i]
        }
      }

      // npm can throw if this field doesn't exist
      result._attachments = {}

      callback(null, result, uplink_errors)
    })
  })
}

//
// Retrieve remote and local packages more recent than {startkey}
//
// Function invokes uplink.request for npm and local.get_recent_packages for
// local ones then sum up the result in a json object
//
// Used storages: local && uplink (proxy_access)
//
Storage.prototype.search = function(startkey, options, callback) {
  var self = this
  var uplinks = []
  var i = 0

  var uplinks
  for (var p in self.uplinks) {
    uplinks.push(p)
  }

  function merge_with_local_packages(err, res, body) {
    if (err) return callback(err)
    var j = 0

    self.local.get_recent_packages(startkey, function(err, list) {
      if (err) return callback(err)

      var listL = list.length

      if (!listL) return callback(null, body)

      list.forEach(function(item) {
        self.local.get_package(item.name, options, function(err, data) {
          if (err) return callback(err)

          var versions = Utils.semver_sort(Object.keys(data.versions))
          var latest = versions[versions.length - 1]

          if (data.versions[latest]) {
            body[item.name] = {
              name          : data.versions[latest].name,
              description   : data.versions[latest].description,
              'dist-tags'   : { latest: latest },
              maintainers   : data.versions[latest].maintainers || [data.versions[latest]._npmUser].filter(Boolean),
              readmeFilename: data.versions[latest].readmeFilename || '',
              time          : {
                modified: new Date(item.time).toISOString()
              },
              versions      : {},
              repository    : data.versions[latest].repository,
              keywords      : data.versions[latest].keywords
            }
            body[item.name].versions[latest] = 'latest'
          }

          if (++j !== listL) {
            return false
          }

          return callback(null, body)
        })
      })
    })
  }

  function remote_search() {
    var uplink = self.uplinks[uplinks[i]]
    if (options.req.query.local !== undefined || !uplink) {
      return merge_with_local_packages(null, null, {})
    }
    self.uplinks[uplinks[i]].request({
      uri: options.req.url,
      timeout: self.uplinks[p].timeout,
      json: true,
    }, function(err, res, body) {
      if (err || Math.floor(res.statusCode / 100) > 3) {
        i++
        return remote_search()
      }
      return merge_with_local_packages(err, res, body)
    })
  }

  remote_search()
}

Storage.prototype.get_local = function(callback) {
  var self = this
  var locals = this.config.localList.get()
  var packages = []

  var getPackage = function(i) {
    self.local.get_package(locals[i], function(err, info) {
      if (!err) {
        var latest = Array.isArray(info['dist-tags'].latest)
                   ? Utils.semver_sort(info['dist-tags'].latest).pop()
                   : info['dist-tags'].latest
        if (info.versions[latest]) {
          packages.push(info.versions[latest])
        } else {
          self.logger.warn( { package: locals[i] }
                          , 'package @{package} does not have a "latest" tag?' )
        }
      }

      if (i >= locals.length - 1) {
        callback(null, packages)
      } else {
        getPackage(i + 1)
      }
    })
  }

  if (locals.length) {
    getPackage(0)
  } else {
    callback(null, [])
  }
}

// function fetches package information from uplinks and synchronizes it with local data
// if package is available locally, it MUST be provided in pkginfo
// returns callback(err, result, uplink_errors)
Storage.prototype._sync_package_with_uplinks = function(name, pkginfo, options, callback) {
  var self = this

  if (!pkginfo) {
    var exists = false

    pkginfo = {
      name        : name,
      versions    : {},
      'dist-tags' : {},
      _uplinks    : {},
    }
  } else {
    var exists = true
  }

  var uplinks = []
  for (var i in self.uplinks) {
    if (self.config.proxy_access(name, i)) {
      uplinks.push(self.uplinks[i])
    }
  }

  async.map(uplinks, function(up, cb) {
    var _options = Object.assign({}, options)
    if (Utils.is_object(pkginfo._uplinks[up.upname])) {
      var fetched = pkginfo._uplinks[up.upname].fetched
      if (fetched && fetched > (Date.now() - up.maxage)) {
        return cb()
      }

      _options.etag = pkginfo._uplinks[up.upname].etag
    }

    up.get_package(name, _options, function(err, up_res, etag) {
      if (err && err.status === 304)
        pkginfo._uplinks[up.upname].fetched = Date.now()

      if (err || !up_res) return cb(null, [err || Error('no data')])

      try {
        Utils.validate_metadata(up_res, name)
      } catch(err) {
        self.logger.error({
          sub: 'out',
          err: err,
        }, 'package.json validating error @{!err.message}\n@{err.stack}')
        return cb(null, [ err ])
      }

      pkginfo._uplinks[up.upname] = {
        etag: etag,
        fetched: Date.now()
      }

      try {
        Storage._merge_versions(pkginfo, up_res, self.config)
      } catch(err) {
        self.logger.error({
          sub: 'out',
          err: err,
        }, 'package.json parsing error @{!err.message}\n@{err.stack}')
        return cb(null, [ err ])
      }

      // if we got to this point, assume that the correct package exists
      // on the uplink
      exists = true
      cb()
    })
  }, function(err, uplink_errors) {
    assert(!err && Array.isArray(uplink_errors))

    if (!exists) {
      return callback( Error[404]('no such package available')
                     , null
                     , uplink_errors )
    }

    self.local.update_versions(name, pkginfo, function(err, pkginfo) {
      if (err) return callback(err)
      return callback(null, pkginfo, uplink_errors)
    })
  })
}

// function gets a local info and an info from uplinks and tries to merge it
// exported for unit tests only
Storage._merge_versions = function(local, up, config) {
  // copy new versions to a cache
  // NOTE: if a certain version was updated, we can't refresh it reliably
  for (var i in up.versions) {
    if (local.versions[i] == null) {
      local.versions[i] = up.versions[i]
    }
  }

  // refresh dist-tags
  for (var i in up['dist-tags']) {
    var added = Utils.tag_version(local, up['dist-tags'][i], i, config || {})
    if (i === 'latest' && added) {
      // if remote has more fresh package, we should borrow its readme
      local.readme = up.readme
    }
  }
}


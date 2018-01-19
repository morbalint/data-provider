import PropTypes from 'prop-types'
import React from 'react'
import lo from 'lodash'
import DataProvider from './DataProvider'
import {assert, IdGenerator} from './util'
import {cfg} from './config'

function call(list) {
  let fn = list[0]
  let args = list.slice(1)
  return fn(...args)
}

const idg = new IdGenerator()
const dataProviders = {}
const dpMap = new Map()
function findDp(ref, rawOnData, rawGetData) {
  let dps = dpMap.get(ref)
  if (dps) {
    for (let [dpId, dp] of dps.entries()) {
      if (dp && lo.isEqual(dp.rawOnData, rawOnData) && lo.isEqual(dp.rawGetData, rawGetData)) {
        if (dp.isExpired()) {
          dps.delete(dpId)
          delete dataProviders[dpId]
        } else {
          return dp.id
        }
      }
    }
  }
  return null
}

function removeUser(dpId, userId) {
  let dp = dataProviders[dpId]
  if (dp.keepAliveFor) {
    dp.disableUser(userId)
  } else {
    dp.removeUser(userId)
    if (lo.isEmpty(dp.userConfigs)) {
      delete dataProviders[dpId]
    }
  }
}

function fetch(dpRef) {
  let found = null
  for (let dp of lo.values(dataProviders)) {
    if (dp.ref === dpRef) {
      if (found != null) {
        throw new Error(`Multiple data providers with the same ref=${dpRef}`)
      }
      found = dp
    }
  }
  if (found == null) {
    throw new Error(`No data provider ref=${dpRef}`)
  }
  return found.fetch(true)
}

export function withRefetch() {
  return (Component) => {
    return class ComponentWithRefetch extends React.Component {
      render() {
        return (
          <Component
            refetch={(dpRef) => {
              // Make sure context is updated (shouldComponentUpdate of some
              // parent component might prevent it from being updated)
              this.forceUpdate()
              fetch(dpRef)
            }}
            {...this.props}
          />)
      }
    }
  }
}

export function withDataProviders(getConfig) {
  return (Component) => {
    return class ComponentWithDataProviders extends React.Component {

      static contextTypes = {
        dispatch: PropTypes.func.isRequired,
        dataProviders: PropTypes.object,
      }

      static childContextTypes = {
        dataProviders: PropTypes.object,
      }

      getChildContext() {
        return {dataProviders: {...this.context.dataProviders, ...this.dataProviders}}
      }

      componentWillMount() {
        this.id = idg.next()
        this.dataProviders = {}
        this.loadingIcon = cfg.loadingIcon
        this.handleUpdate(this.props)
        this.mounted = true
      }

      componentWillReceiveProps(nextProps) {
        // Make sure context is updated (shouldComponentUpdate of some parent
        // component might prevent it from being updated)
        if (!lo.isEqual(this.props, nextProps)) {
          this.forceUpdate()
          this.handleUpdate(nextProps)
        }
      }

      componentWillUnmount() {
        for (let dpId in this.dataProviders) {
          removeUser(dpId, this.id)
        }
        this.mounted = false
      }

      updateMountedComponent() {
        if (this.mounted) {
          this.forceUpdate()
        }
      }

      handleUpdate(props) {
        let newDataProviders = {}

        for (let dpConfig of getConfig(props)) {
          let {
            ref,
            getData: rawGetData,
            onData: rawOnData,
            initialData,
            polling,
            needed,
            loadingIcon,
            responseHandler = cfg.responseHandler,
            keepAliveFor = 0
          } = dpConfig
          assert(Number.isInteger(keepAliveFor) && keepAliveFor >= 0,
            'Parameter keepAliveFor must be a positive Integer or 0')

          this.loadingIcon = loadingIcon === undefined ? this.loadingIcon : loadingIcon

          // Look for data provider with this ref among data providers of this
          // component and data providers of its DOM ancestors
          let dpId = lo.findKey(
            {...this.context.dataProviders, ...this.dataProviders},
            (dpRef) => lo.isEqual(dpRef, ref))

          if (dpId == null && keepAliveFor) {
            dpId = findDp(ref, rawOnData, rawGetData)
          }
          if (dpId == null) {
            assert(rawOnData != null && rawGetData != null,
              'Parameters onData, getData have to be provided, if data' +
              `provider was not defined yet. See DP ${ref}`
            )

            dpId = idg.next()
            dataProviders[dpId] = new DataProvider({
              id: dpId,
              ref,
              rawOnData,
              onData: (data) => {
                call(rawOnData)(ref, data, this.context.dispatch)
                this.updateMountedComponent()
              },
              initialData,
              responseHandler,
              keepAliveFor
            })
            if (keepAliveFor) {
              if (dpMap.has(ref)) {
                dpMap.get(ref).set(dpId, dataProviders[dpId])
              } else {
                dpMap.set(ref, new Map([[dpId, dataProviders[dpId]]]))
              }
            }
          }

          let dp = dataProviders[dpId]

          // Changing onData for existing data provider is not currently
          // supported
          assert(
            rawOnData == null || lo.isEqual(rawOnData, dp.rawOnData),
            `Provided onData for DP ${ref}\n${rawOnData}\n` +
            `is not equal to previous onData\n${dp.rawOnData}`
          )

          // If the data provider was already defined in some DOM ancestor,
          // require equality on getData (i.e. there can be only one definition
          // of getData for any tuple of (ref, moment in time, DOM node))
          if (lo.has(this.context.dataProviders, dpId)) {
            assert(
              rawGetData == null || lo.isEqual(rawGetData, dp.rawGetData),
              `Provided getData for DP ${ref}\n${rawGetData}\n` +
              `is not equal to previous getData\n${dp.rawGetData}`
            )
          }

          dp.updateUser(this.id, {
            polling,
            needed,
            rawGetData,
            getData: () => call(rawGetData)
          })
          newDataProviders[dpId] = dp.ref
        }

        // this is used when handleUpdate is called for existing component, but with new props,
        // so its data providers could've changed
        for (let dpId in this.dataProviders) {
          if (!lo.has(newDataProviders, dpId)) {
            removeUser(dpId, this.id)
          }
        }

        this.dataProviders = newDataProviders

        this.forceUpdate()
      }

      render() {
        let show = lo.keys(this.dataProviders).every((id) => {
          let dp = dataProviders[id]
          return !dp.userConfigs.get(this.id).needed || dp.loaded
        })
        return show ? <Component {...this.props} /> : this.loadingIcon
      }
    }
  }
}

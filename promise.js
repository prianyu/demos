class Promise {
  constructor(executor) {
    if (new.target !== Promise) {
      throw new TypeError('Promise constructor cannot be invoked without new operator');
    }

    if (typeof executor !== 'function') {
      throw new TypeError(`Promise resolver ${executor} is not a function`)
    }

    this.state = 'pending'
    this.value = undefined
    this.reason = undefined
    this.onFulfilledCallbacks = []
    this.onRejectedCallbacks = []

    const resolve = (value) => {
      if (value instanceof Promise) {
        return value.then(resolve, reject)
      }

      runTask(() => {
        if (this.state !== 'pending') return
        this.value = value
        this.state = 'fulfilled'
        this.onFulfilledCallbacks.forEach(fn => fn(this.value))
      })
    }

    const reject = reason => {
      let handled = false
      runTask(() => {
        if (this.state !== 'pending') return
        this.reason = reason
        this.state = 'rejected'
        this.onRejectedCallbacks.forEach(fn => {
          handled = true
          fn(this.reason)
        })
        // 实际应该触发PromiseRejectionEvent
        if (!handled) console.error("Uncaught (in promise)", reason)
        // if (!handled) {
        //   // 浏览器环境
        //   // new EventTarget().dispatchEvent(new PromiseRejectionEvent('reject', {
        //   //   promise: this,
        //   //   reason
        //   // }))

        //   // node环境
        //   // process.emit('unhandledRejection', reason, this)
        // }
      })
    }

    try {
      executor(resolve, reject) // 同步执行
    } catch (error) { // 抛出错误，promise需要被reject
      reject(error)
    }
  }

  then(onFulfilled, onRejected) {
    /*
     * 回调穿透，如果上一级的未传入回调，直接传递给下一级
     * 原理是：then方法返回的是一个新的Promise，会创建新的的onFulfilledCallbacks和onRejectedCallbacks
     * 在执行resolve和reject时会从这两个数组中取出回调执行，如果数组为空，则不会执行
     * 这将导致在链式调用时，上一级Promise如果未定义回调，则上一级的resolve和reject结果无法传递给下一级
     * 因此需要进行回调穿透，即在上一级Promise中，如果未定义回调，则将回调传递给下一级
     * 否则，类似如下代码将无法如期工作
     * let p = new Promise(resolve => resolve('success'))
     * p.then().then(a, b) // 不会接收到'success'
     * 
     * 
     * let p2 = new Promise(resolve => reject('fail'))
     * p.then().catch(err => console.log(err)) // 不会打印err
     * 
    */
    onFulfilled = isFunction(onFulfilled) ? onFulfilled : value => value
    onRejected = isFunction(onRejected) ? onRejected : reason => { throw reason }

    let newPromise = new Promise((resolve, reject) => {
      function call(fn) {
        try {
          fn()
        } catch (error) {
          reject(error)
        }
      }
      if (this.state === 'fulfilled') {
        runTask(() => {
          call(() => {
            let x = onFulfilled(this.value)
            resolvePromise(newPromise, x, resolve, reject)
          })
        })
        return
      }

      if (this.state === 'rejected') {
        runTask(() => {
          call(() => {
            let x = onRejected(this.reason)
            resolvePromise(newPromise, x, resolve, reject)
          })
        })
        return
      }

      if (this.state === 'pending') {
        this.onFulfilledCallbacks.push(() => {
          call(() => {
            let x = onFulfilled(this.value)
            resolvePromise(newPromise, x, resolve, reject)
          })
        })

        this.onRejectedCallbacks.push(() => {
          call(() => {
            let x = onRejected(this.reason)
            resolvePromise(newPromise, x, resolve, reject)
          })
        })
      }
    })

    return newPromise
  }

  catch(onRejected) {
    return this.then(undefined, onRejected)
  }

  finally(onFinally) {
    // onFinally调用时不带任何参数，且返回值被忽略
    return this.then(
      value => Promise.resolve(onFinally()).then(() => value),
      reason => Promise.resolve(onFinally()).then(() => { throw reason })
    )
  }

  static resolve(value) {
    if (value instanceof Promise) return value
    // 之所以返回thenable，是为了让Promise.resolve(thenable)能够正常工作
    return new Promise(resolve => resolve(value)).then(value => value)
  }

  static reject(reason) {
    return new Promise((resolve, reject) => reject(reason))
  }

  static all(promises) {
    return new Promise((resolve, reject) => {
      const result = []
      let count = 0
      for (let i = 0; i < promises.length; i++) {
        const p = promises[i]
        p.then(value => {
          count++
          result[i] = value
          if (count === promises.length) {
            resolve(result)
          }
        }).catch(reject)
      }
    })
  }

  static race(promises) {
    return new Promise((resolve, reject) => {
      for (let i = 0; i < promises.length; i++) {
        const p = promises[i]
        p.then(resolve).catch(reject)
      }
    })
  }

  static any(promises) {
    return new Promise((resolve, reject) => {
      const errors = []
      let count = 0
      for (let i = 0; i < promises.length; i++) {
        const p = promises[i]
        p.then(resolve).catch(reason => {
          count++
          errors[i] = reason
          if (count === promises.length) {
            reject('none resolved', new AggregateError(errors))
          }
        })
      }
    })
  }

  static allSettled(promises) {
    return new Promise((resolve, reject) => {
      const results = []
      let count = 0
      for (let i = 0; i < promises.length; i++) {
        const p = promises[i]
        p.then(value => {
          results[i] = { status: 'fulfilled', value }
        }).catch(reason => {
          results[i] = { status: 'rejected', reason }
        }).finally(() => {
          count++
          if (count === promises.length) {
            resolve(results)
          }
        })
      }
    })
  }

  static withResolvers() {
    let resolve, reject
    const promise = new Promise((_resolve, _reject) => {
      resolve = _resolve
      reject = _reject
    })
    return {
      promise,
      resolve,
      reject
    }
  }
}

function isFunction(o) {
  return typeof o === 'function'
}

// onFulfilled和onRejected只允许在execution context栈仅包含平台代码时执行
// 其执行必须是异步的，且在then方法被调用的那一轮事件循环之后的新执行栈中执行
// 一般是使用微任务来实现，但是实践中
// 通常使用MutationObserver或setImmediate或setTimeout来模拟异步
function runTask(task) {
  setTimeout(task, 0)
}


/**
 * Promise解析过程
 * @param {Promise} promise promise1.then返回的promise2
 * @param {any} x promise1的onFulfilled或onRejected的返回值
 * @param {Function} resolve promise2的resolve
 * @param {Function} reject promise2的reject
 */
function resolvePromise(promise, x, resolve, reject) {
  // 1. 如果promise和x指向同一个对象，以TypeError为据因拒绝执行promise，防止循环引用
  if (promise === x) {
    return reject(new TypeError('Chaining cycle detected for promise'))
  }

  let called = false // 处理thenable时，确保resolve和reject只被调用一次
  // 2. 如果x是一个promise，则让promise接受x的状态
  if (x instanceof Promise) {
    // 2.1 如果x处于pending状态，promise必须保持pending状态，直到x被fulfilled或rejected
    if (x.state === 'pending') {
      x.then(
        value => resolvePromise(promise, value, resolve, reject),
        reason => reject(reason)
      )
    } else { // 2.2 如果x处于fulfilled或rejected状态，则用相同的value执行promise
      x.then(resolve, reject)
    }
  } else if (isFunction(x) || typeof x === 'object' && x !== null) { // 3. 如果x是一个对象或函数
    try {
      let then = x.then
      if (isFunction(then)) { // 3.1 x上具有then方法（thenable对象）
        // 3.1.1 将x作为this绑定，执行then方法
        then.call(
          x,
          y => {
            if (called) return // resolve只能被执行一次
            called = true
            resolvePromise(promise, y, resolve, reject)
          },
          r => {
            if (called) return // reject只能被执行一次
            called = true
            reject(r)
          }
        )
      } else { // 3.2 x上没有then方法（普通对象）
        resolve(x)
      }
    } catch (e) { // 检索x.then失败
      if (called) return
      called = true
      reject(e)
    }
  } else { // 4. 如果x是一个原始值，或者是一个不具有then方法的对象
    resolve(x)
  }
}


// -----------------------------------------test-------------------------------------

// -------1. execution不是函数
// const promise = new Promise({ a: 1 })

// -------2. 普通使用
// new Promise((resolve) => {
//   setTimeout(() => {
//     resolve('123')
//   }, 1000)
// }).then(res => {
//   console.log(res)
// }).catch(err => {
//   console.log(err)
// })

// new Promise((resolve, reject) => {
//   setTimeout(() => {
//     resolve('456')
//   }, 1000)
// }).then(res => {
//   console.log(res)
//   throw 888
// }).catch(err => {
//   console.log("&&&&&&&&&&&")
//   console.log(err)
// })

// 3. 链式调用
// new Promise((resolve, reject) => {
//   setTimeout(() => {
//     resolve('start')
//   }, 1000)
// }).then(res => {
//   console.log(res)
//   return 123
// }).then(res => {
//   console.log(res)
//   throw 456
// }).catch(err => {
//   console.log(err)
//   return 'finish'
// }).then(res => {
//   console.log(res)
// }).finally(() => {
//   console.log("finally")
// })



// -------4. 回调穿透
// new Promise((resolve) => {
//   setTimeout(() => resolve("success"), 1000)
// }).then().then().then(res => {
//   console.log(res)
// })

// new Promise((resolve, reject) => {
//   setTimeout(() => reject("fail"), 1000)
// }).then().then().then(res => {
//   console.log(res)
// }).catch(err => {
//   console.log(err)
// })

//-------5. 循环引用
// const p = new Promise(resolve => {
//   resolve(123)
// }).then(res => {
//   return p
// })

// ----6. 未捕获错误
new Promise((_, reject) => {
  reject("未捕获的错误")
})

// new Promise((resolve, reject) => {
//   setTimeout(() => {
//     resolve('123')
//   }, 1000)
// }).then(res => {
//   console.log(res)
// }).catch(err => {
//   console.log(err)
// }).then(res => {
//   throw '被捕获错误'
// }).catch(err => {
//   console.log('捕获到了:', err)
// }).then(() => {
//   throw "未捕获错误"
// })

// 7. then不会被resolve或者reject
// var p = new Promise(resolve => {
//   setTimeout(() => {
//     console.log('oooooo')
//     // 此次返回的是p，p是then返回的新的promise，因此会等待p的状态改变
//     // 但是then不会被resolve或者reject
//     resolve(p)
//   }, 500)
// }).then(res => {
//   // 该回调不回被执行，因为then饭会的promise不会被resolve或者reject
//   console.log(123)
//   console.log(res)
//   return 3
// }).catch(err => {
//   console.log(err)
// })

//-----8. all
// const p1 = new Promise((resolve, reject) => {
//   setTimeout(() => {
//     resolve("p1 success")
//   }, 100)
// })
// const p2 = new Promise((resolve, reject) => {
//   setTimeout(() => {
//     resolve("p2 success")
//   }, 100)
// })
// const p3 = new Promise((resolve, reject) => {
//   setTimeout(() => {
//     resolve("p3 success")
//   }, 100)
// })
// const p4 = new Promise((resolve, reject) => {
//   setTimeout(() => {
//     reject("p4 fail")
//   }, 100)
// })

// const p5 = new Promise((resolve, reject) => {
//   setTimeout(() => {
//     reject("p5 fail")
//   }, 100)
// })

//-- all
// Promise.all([p1, p2, p3, p4]).then(res => {
//   console.log("all成功了", res)
// }).catch(err => {
//   console.log("all失败了", err)
// })

// Promise.all([p2, p3, p1]).then(res => {
//   console.log("all成功了", res)
// }).catch(err => {
//   console.log("all失败了", err)
// })

// allSettled
// Promise.allSettled([p1, p2, p4, p5]).then(res => {
//   console.log(res)
// })

// race
// Promise.race([p1, p2, p3, p4]).then(res => {
//   console.log("race成功了", res)
// }).catch(err => {
//   console.log("race失败了", err)
// })

// any
// Promise.any([p1, p2, p3, p4, p5]).then(res => {
//   console.log("any成功了", res)
// }).catch(err => {
//   console.log("any失败了", err)
// })

// resolve, reject
// Promise.resolve("resolve").then(res => console.log('成功', res)).catch(err => console.log('失败', err))
// Promise.reject("reject").then(res => console.log('成功', res)).catch(err => console.log('失败', err))

//-- 9. withResolves
// const { promise, resolve, reject } = Promise.withResolvers()

// promise.then(res => {
//   console.log(res)
// })

// setTimeout(() => {
//   Math.random() > 0.5 ? resolve("成功") : reject("失败")
// }, 500)

//-- 10. thenable
// const aThenable = {
//   then(onFulfilled, onRejected) {
//     onFulfilled({
//       // thenable 对象被兑现为另一个 thenable 对象
//       then(onFulfilled, onRejected) {
//         onFulfilled(42);
//       },
//     });
//   },
// };

// Promise.resolve(23).then(res => {
//   return aThenable
// }).then(res => {
//   console.log(res)
// })

// Promise.resolve(aThenable).then(res => {
//   console.log(res)
// })
// --------------测试用例

// https://github.com/promises-aplus/promises-tests
// npm i -g promises-aplus-tests
// promises-aplus-tests promise.js
// jquery deferred
Promise.deferred = function () { // 延迟对象
  let defer = {};
  defer.promise = new Promise((resolve, reject) => {
    defer.resolve = resolve;
    defer.reject = reject;
  });
  return defer;
}
try {
  module.exports = Promise
} catch (e) {

}

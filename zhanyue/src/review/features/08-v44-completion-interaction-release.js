
(() => {
  function stopAutomaticCameraV44() {
    if (typeof window.__zhanyueStopBakedCamera === 'function') {
      window.__zhanyueStopBakedCamera();
    }

    if (state.cameraFollowRAF) {
      cancelAnimationFrame(state.cameraFollowRAF);
      state.cameraFollowRAF = 0;
    }

    if (state.trueCameraRAF) {
      cancelAnimationFrame(state.trueCameraRAF);
      state.trueCameraRAF = 0;
    }

    clearTimeout(state.cameraResumeTimer);
    state.cameraTargetView = null;
    state.trueCameraTarget = null;
    state.cameraFollowEnabled = false;
  }

  function releaseCompletedInteractionV44() {
    if (!document.body.classList.contains('line-completed')) return;

    stopAutomaticCameraV44();

    // 完成态只关闭自动跟随，不锁定用户交互。
    state.cameraSuspended = false;

    document.body.classList.remove(
      'camera-following',
      'is-view-animating',
      'is-map-navigating',
      'route-stretching',
      'line-completing',
      'map-flipping'
    );

    mapStage.style.removeProperty('pointer-events');
    routeLayer.style.removeProperty('pointer-events');

    routeGroupMap.forEach(group => {
      group.style.removeProperty('pointer-events');
      const hit = group.querySelector('.route-hit');
      if (hit) hit.style.removeProperty('pointer-events');
    });
  }

  /*
   * 只监听 line-completed 首次出现，不在观察器中写回 viewBox，
   * 也不反复修改 body class，避免递归 MutationObserver 循环。
   */
  let wasCompletedV44 = document.body.classList.contains('line-completed');

  const observerV44 = new MutationObserver(() => {
    const completed = document.body.classList.contains('line-completed');

    if (completed && !wasCompletedV44) {
      requestAnimationFrame(releaseCompletedInteractionV44);
    }

    wasCompletedV44 = completed;
  });

  observerV44.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  // 用户主动开始地图手势时，始终允许正常进入导航流程。
  const previousBeginMapNavigationV44 = beginMapNavigation;
  beginMapNavigation = function(...args) {
    if (document.body.classList.contains('line-completed')) {
      stopAutomaticCameraV44();
      state.cameraSuspended = false;
    }
    return previousBeginMapNavigationV44(...args);
  };

  const previousScheduleMapNavigationEndV44 = scheduleMapNavigationEnd;
  scheduleMapNavigationEnd = function(...args) {
    const result = previousScheduleMapNavigationEndV44(...args);

    if (document.body.classList.contains('line-completed')) {
      clearTimeout(state.cameraResumeTimer);
      state.cameraResumeTimer = setTimeout(() => {
        state.cameraSuspended = false;
        stopAutomaticCameraV44();
      }, 120);
    }

    return result;
  };

  // 完成状态下仍允许顶部按钮、输入方案选择和返回首页等常规交互。
  document.addEventListener('pointerdown', event => {
    if (!document.body.classList.contains('line-completed')) return;
    if (event.target.closest('button,select,input,.segmented,.line-strip')) {
      releaseCompletedInteractionV44();
    }
  }, { capture: true, passive: true });

  releaseCompletedInteractionV44();
})();

const PRACTICE_MODES = new Set(['overview', 'timed', 'full']);
const VIEW_MODES = new Set(['flat', 'animated', 'real']);

export const INITIAL_LEARN_STATE = Object.freeze({
  route: null,
  direction: 'forward',
  browseIndex: 0,
  practiceMode: 'overview',
  viewMode: 'flat',
  broadcasting: false,
  presentationRevision: null,
});

export function reduceLearnState(state, action) {
  switch (action?.type) {
    case 'ROUTE_SELECTED':
      return {
        ...state,
        route: action.route,
        direction: 'forward',
        browseIndex: Math.max(0, Number(action.browseIndex) || 0),
        practiceMode: 'overview',
        viewMode: 'flat',
        broadcasting: false,
      };
    case 'ROUTE_CLEARED':
      return {...state, ...INITIAL_LEARN_STATE, presentationRevision: state.presentationRevision};
    case 'BROWSE_CHANGED':
      return {...state, browseIndex: Math.max(0, Number(action.index) || 0)};
    case 'DIRECTION_CHANGED':
      return {
        ...state,
        direction: action.direction === 'reverse' ? 'reverse' : 'forward',
        browseIndex: action.browseIndex == null
          ? state.browseIndex
          : Math.max(0, Number(action.browseIndex) || 0),
      };
    case 'PRACTICE_STARTED':
      return {
        ...state,
        practiceMode: PRACTICE_MODES.has(action.mode) && action.mode !== 'overview' ? action.mode : 'timed',
        browseIndex: 0,
        broadcasting: false,
      };
    case 'PRACTICE_EXITED':
      return {...state, practiceMode: 'overview'};
    case 'VIEW_CHANGED':
      return {...state, viewMode: VIEW_MODES.has(action.mode) ? action.mode : 'flat'};
    case 'BROADCAST_CHANGED':
      return {...state, broadcasting: Boolean(action.broadcasting)};
    case 'PRESENTATION_LOADED':
      return {...state, presentationRevision: action.revision || null};
    default:
      throw new TypeError(`未知 LearnStore action：${action?.type || 'undefined'}`);
  }
}

export class LearnStore {
  constructor(initial = {}) {
    this.state = Object.freeze({...INITIAL_LEARN_STATE, ...initial});
    this.listeners = new Set();
  }

  getState() { return this.state; }

  dispatch(action) {
    const next = Object.freeze(reduceLearnState(this.state, action));
    if (next === this.state) return this.state;
    const previous = this.state;
    this.state = next;
    this.listeners.forEach(listener => listener(next, previous, action));
    return next;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

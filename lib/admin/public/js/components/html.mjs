// One import for every view and component: Preact, its hooks and htm bound to `h`.
// Text children are escaped by Preact; never build markup from strings (CSP, FR-010).
import { h, render, Fragment, Component, createContext, createRef, cloneElement, toChildArray } from "../../vendor/preact.mjs";
import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useRef,
  useReducer,
  useContext,
  useId,
  useErrorBoundary,
} from "../../vendor/preact-hooks.mjs";
import htm from "../../vendor/htm.mjs";

export const html = htm.bind(h);

export {
  h,
  render,
  Fragment,
  Component,
  createContext,
  createRef,
  cloneElement,
  toChildArray,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useRef,
  useReducer,
  useContext,
  useId,
  useErrorBoundary,
};
